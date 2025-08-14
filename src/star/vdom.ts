export const enum VNodeKind {
  Element = 0,
  Text = 1,
}

export interface VElement {
  kind: VNodeKind.Element;
  tag: string;
  attrs: Record<string, string>;
  children: VNode[];
}

export interface VText {
  kind: VNodeKind.Text;
  text: string;
}

export type VNode = VElement | VText;

export function element(
  tag: string,
  attrs: Record<string, string> = {},
  children: VNode[] = [],
): VElement {
  return { kind: VNodeKind.Element, tag, attrs, children };
}

export function text(content: string): VText {
  return { kind: VNodeKind.Text, text: content };
}

export function isElement(node: VNode): node is VElement {
  return node.kind === VNodeKind.Element;
}

export function isText(node: VNode): node is VText {
  return node.kind === VNodeKind.Text;
}
