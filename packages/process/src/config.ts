import { Node, Schema } from '@markdoc/markdoc';

export type Config = {
    extensions: string[];
    nodes: Record<string, Node>;
    layout: string | null;
};
