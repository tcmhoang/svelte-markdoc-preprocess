import {
    Schema,
    SchemaAttribute,
    parse as markdocParse,
    transform,
    NodeType,
    Tag,
    ConfigType,
} from '@markdoc/markdoc';
import {
    ScriptTarget,
    SyntaxKind,
    VariableDeclaration,
    createSourceFile,
    getJSDocType,
    getNameOfDeclaration,
    isVariableStatement,
} from 'typescript';
import { dirname, join } from 'path';
import { load as loadYaml } from 'js-yaml';
import { parse as svelteParse, walk } from 'svelte/compiler';
import { get_all_files, path_exists, read_file, write_to_file } from './utils';
import * as default_schema from './default_schema';
import type { Config } from './config';
import { render_html } from './renderer';

type Var = {
    name: string;
    type: StringConstructor | NumberConstructor | BooleanConstructor;
};

export function transformer({
    content,
    nodes_file,
    tags_file,
    partials_dir,
    layouts,
    generate_schema,
    config,
}: {
    content: string;
    nodes_file: Config['nodes'];
    tags_file: Config['tags'];
    partials_dir: Config['partials'];
    layouts: Config['layouts'];
    generate_schema: Config['generateSchema'];
    config: Config['config'];
}): string {
    /**
     * create ast for markdoc
     */
    const ast = markdocParse(content);

    /**
     * load frontmatter
     */
    const frontmatter = (
        ast.attributes.frontmatter ? loadYaml(ast.attributes.frontmatter) : {}
    ) as Record<string, string>;

    /**
     * get layout from frontmatter, use default or no at all
     */
    const selected_layout = layouts
        ? layouts[frontmatter?.layout ?? 'default'] ?? undefined
        : undefined;
    const has_layout = selected_layout !== undefined;

    /**
     * add used svelte components to the script tag
     */
    let dependencies = '';
    const tags = prepare_tags(tags_file);
    const has_tags = Object.keys(tags).length > 0;
    const nodes = prepare_nodes(nodes_file);
    const has_nodes = Object.keys(nodes).length > 0;
    const partials = prepare_partials(partials_dir);

    /**
     * add import for tags
     */
    if (has_tags) {
        dependencies += `import * as INTERNAL__TAGS from '${tags_file}';`;
    }

    /**
     * add import for nodes
     */
    if (has_nodes) {
        dependencies += `import * as INTERNAL__NODES from '${nodes_file}';`;
    }

    /**
     * add import for layout
     */
    if (has_layout) {
        dependencies += `import INTERNAL__LAYOUT from '${selected_layout}';`;
    }

    if (generate_schema) {
        create_schema(tags);
    }

    const configuration: ConfigType = {
        tags: {
            ...config?.tags,
            ...tags,
        },
        nodes: {
            ...config?.nodes,
            ...nodes,
        },
        partials: {
            ...config?.partials,
            ...partials,
        },
        variables: {
            ...config?.variables,
            frontmatter,
        },
        functions: config?.functions,
        validation: config?.validation,
    };

    /**
     * transform the ast with svelte components
     */
    const nast = transform(ast, configuration);

    /**
     * render to html
     */
    // const code = sanitize_for_svelte(render_html(nast));
    const code = render_html(nast);

    let transformed = '';

    /**
     * add module context if frontmatter is usef
     */
    if (Object.keys(frontmatter).length > 0) {
        transformed += create_module_context(frontmatter);
    }

    /**
     * add all dependencies to the document
     */
    if (dependencies) {
        transformed += `<script>${dependencies}</script>`;
    }
    /**
     * wrap the document in the layout
     */
    if (has_layout) {
        transformed += `<INTERNAL__LAYOUT>${code}</INTERNAL__LAYOUT>`;
    } else {
        transformed += code;
    }

    return transformed;
}

export function create_module_context(
    frontmatter: Record<string, string>,
): string {
    return (
        `<script context="module">` +
        `export const frontmatter = ${JSON.stringify(frontmatter)};` +
        `</script>`
    );
}

const script_tags_regular_expression = new RegExp(
    '<script[^>]*>(.*?)</script>',
    's',
);

export function get_component_vars(
    path: string,
    layout: string,
): Record<string, SchemaAttribute> {
    const target = join(dirname(layout), path);
    const data = read_file(target);
    const match = data.match(script_tags_regular_expression);
    if (!match) {
        return {};
    }

    /**
     * create an ast using typescript
     */
    const script = match[1];
    const source = createSourceFile(target, script, ScriptTarget.Latest, true);

    /**
     * find and return all exported variables
     */
    return source.statements.reduce<Record<string, SchemaAttribute>>(
        (prev, node) => {
            if (isVariableStatement(node)) {
                const is_export_keyword = node.modifiers?.some(
                    (v) => v.kind === SyntaxKind.ExportKeyword,
                );
                if (is_export_keyword) {
                    const declaration = node.declarationList.declarations.find(
                        (d) => d.name.kind === SyntaxKind.Identifier,
                    );
                    const name =
                        getNameOfDeclaration(declaration)?.getText(source);
                    if (!declaration || !name) {
                        return prev;
                    }
                    const type = ts_to_type(declaration);
                    prev[name] = {
                        type,
                        required: !declaration.initializer,
                    };
                }
            }

            return prev;
        },
        {},
    );
}

const uc_map: Record<string, string> = {
    '{': '&lcub;',
    '}': '&rcub;',
};
const uc_regular_expression = new RegExp(Object.keys(uc_map).join('|'), 'gi');

export function sanitize_for_svelte(content: string): string {
    return content.replace(
        uc_regular_expression,
        (matched) => uc_map[matched.toLowerCase()],
    );
}

export function ts_to_type(declaration: VariableDeclaration): Var['type'] {
    const kind = declaration.type?.kind
        ? declaration.type.kind
        : getJSDocType(declaration.parent.parent)?.kind;
    if (kind) {
        switch (kind) {
            case SyntaxKind.StringKeyword:
                return String;
            case SyntaxKind.NumberKeyword:
                return Number;
            case SyntaxKind.BooleanKeyword:
                return Boolean;
            default:
                throw new Error('Can only handly primitive types.');
        }
    }

    return String;
}

function get_node_defaults(node_type: NodeType): Partial<Schema> {
    switch (node_type) {
        case 'blockquote':
            return default_schema.blockquote;
        case 'em':
            return default_schema.em;
        case 'heading':
            return default_schema.heading;
        case 'hr':
            return default_schema.hr;
        case 'image':
            return default_schema.image;
        case 'inline':
            return default_schema.inline;
        case 'item':
            return default_schema.item;
        case 'link':
            return default_schema.link;
        case 'list':
            return default_schema.list;
        case 'paragraph':
            return default_schema.paragraph;
        case 'strong':
            return default_schema.strong;
        case 'table':
            return default_schema.table;
        case 'code':
            return default_schema.code;
        case 'comment':
            return default_schema.comment;
        case 'document':
            return default_schema.document;
        case 'error':
            return default_schema.error;
        case 'fence':
            return default_schema.fence;
        case 'hardbreak':
            return default_schema.hardbreak;
        case 'node':
            return default_schema.node;
        case 's':
            return default_schema.s;
        case 'softbreak':
            return default_schema.softbreak;
        case 'tbody':
            return default_schema.tbody;
        case 'td':
            return default_schema.td;
        case 'text':
            return default_schema.text;
        case 'th':
            return default_schema.th;
        case 'thead':
            return default_schema.thead;
        case 'tr':
            return default_schema.tr;
        default:
            throw new Error(`Unknown node type: ${node_type}`);
    }
}

function prepare_nodes(
    nodes_file: Config['nodes'],
): Partial<Record<NodeType, Schema>> {
    const nodes: Record<string, Schema> = {};
    if (nodes_file) {
        for (const [name] of each_exported_var(nodes_file)) {
            nodes[name.toLowerCase()] = {
                ...get_node_defaults(name.toLowerCase() as NodeType),
                transform(node, config) {
                    return new Tag(
                        `INTERNAL__NODES.${name}`,
                        node.transformAttributes(config),
                        node.transformChildren(config),
                    );
                },
            };
        }
    }

    return nodes;
}

function prepare_tags(tags_file: Config['tags']): Record<string, Schema> {
    const tags: Record<string, Schema> = {};
    if (tags_file) {
        for (const [name, value] of each_exported_var(tags_file)) {
            /**
             * extract all exported variables from the components
             */
            const attributes = get_component_vars(String(value), tags_file);
            tags[name.toLowerCase()] = {
                render: 'INTERNAL__TAGS.' + name,
                attributes,
            };
        }
    }
    return tags;
}

function prepare_partials(
    folder: Config['partials'],
): Record<string, ReturnType<typeof markdocParse>> {
    if (!folder) {
        return {};
    }

    return get_all_files(folder).reduce<ReturnType<typeof prepare_partials>>(
        (carry, file) => {
            carry[file] = markdocParse(read_file(folder, file));
            return carry;
        },
        {},
    );
}

function each_exported_var(filepath: string): Array<[string, string]> {
    const data = read_file(filepath);
    const ast = svelteParse(data);
    const tup: Array<[string, string]> = [];
    //@ts-ignore weird types here from svelte
    walk(ast, {
        enter(node, parent) {
            if (node.type === 'ExportSpecifier') {
                if (
                    parent?.type === 'ExportNamedDeclaration' &&
                    parent?.source
                ) {
                    tup.push([node.exported.name, String(parent.source.value)]);
                }
            }
        },
    });

    return tup;
}

function create_schema(tags: Record<string, Schema>): void {
    // TODO: this part is really ugly, but it works.
    const raw = JSON.stringify(tags, (key, value) => {
        if (key === 'type') {
            switch (true) {
                case value === Number:
                    return '%%NUMBER%%';
                case value === String:
                    return '%%STRING%%';
                case value === Boolean:
                    return '%%BOOLEAN%%';
            }
        }
        return value;
    });
    const object = raw
        .replaceAll('"%%NUMBER%%"', 'Number')
        .replaceAll('"%%STRING%%"', 'String')
        .replaceAll('"%%BOOLEAN%%"', 'Boolean');
    const content = `export default { tags: ${object} };`;

    const target_directory = join(process.cwd(), '.svelte-kit');
    const target_file = join(target_directory, 'markdoc_schema.js');
    if (path_exists(target_directory)) {
        try {
            if (path_exists(target_file)) {
                if (content === read_file(target_file)) {
                    return;
                }
            }
            write_to_file(target_file, content);
        } catch (err) {
            console.error(err);
        }
    }
}
