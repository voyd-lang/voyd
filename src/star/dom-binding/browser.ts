import { DomBinding, VElement, VNode, VText, setDomBinding } from "../dom-binding.js";

const browserBinding: DomBinding = {
  createElement(tag: string): VElement {
    return document.createElement(tag) as unknown as VElement;
  },
  createTextNode(text: string): VText {
    return document.createTextNode(text) as unknown as VText;
  },
  setAttribute(el: VElement, name: string, value: string): void {
    (el as unknown as Element).setAttribute(name, value);
  },
  removeAttribute(el: VElement, name: string): void {
    (el as unknown as Element).removeAttribute(name);
  },
  appendChild(parent: VNode, child: VNode): void {
    (parent as unknown as Node).appendChild(child as unknown as Node);
  },
  removeChild(parent: VNode, child: VNode): void {
    (parent as unknown as Node).removeChild(child as unknown as Node);
  },
  insertBefore(parent: VNode, child: VNode, ref: VNode | null): void {
    (parent as unknown as Node).insertBefore(child as unknown as Node, ref as unknown as Node | null);
  },
  setText(node: VNode, text: string): void {
    (node as unknown as Node).textContent = text;
  },
};

export function initBrowserDomBinding(): void {
  setDomBinding(browserBinding);
}

export default browserBinding;
