import { JSDOM } from "jsdom";
import { setDomBinding, type DomBinding, type VNode, type VElement, type VText } from "../dom-binding.js";

/**
 * Initialize a jsdom-backed DOM binding and register it for star.voyd.
 * Returns the created JSDOM instance so callers can access the document.
 */
export function initJsdomDomBinding(): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body></body></html>`);
  const { document } = dom.window;

  const binding: DomBinding = {
    createElement(tag: string): VElement {
      return document.createElement(tag);
    },
    createTextNode(text: string): VText {
      return document.createTextNode(text);
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

  setDomBinding(binding);
  return dom;
}
