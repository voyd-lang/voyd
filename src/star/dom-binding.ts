export interface VNode {}
export interface VElement extends VNode {}
export interface VText extends VNode {}

export interface DomBinding {
  /** Create an element with the given tag name */
  createElement(tag: string): VElement;
  /** Create a text node */
  createTextNode(text: string): VText;
  /** Set an attribute on an element */
  setAttribute(el: VElement, name: string, value: string): void;
  /** Remove an attribute from an element */
  removeAttribute(el: VElement, name: string): void;
  /** Append a child to a parent node */
  appendChild(parent: VNode, child: VNode): void;
  /** Remove a child from a parent node */
  removeChild(parent: VNode, child: VNode): void;
  /** Insert a child before a reference node */
  insertBefore(parent: VNode, child: VNode, ref: VNode | null): void;
  /** Set the text content of a node */
  setText(node: VNode, text: string): void;
}

let currentBinding: DomBinding | undefined;

export function setDomBinding(binding: DomBinding): void {
  currentBinding = binding;
}

export function getDomBinding(): DomBinding {
  if (!currentBinding) {
    throw new Error("DOM binding has not been set");
  }
  return currentBinding;
}
