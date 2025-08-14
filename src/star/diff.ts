import { VNode, isElement, isText } from "./vdom.js";
import type { DomBinding } from "./dom-binding.js";

// A patch is a function that, when invoked with a DomBinding, mutates the real DOM
export type Patch = (dom: DomBinding) => void;

// Create a real DOM node from a virtual node using the provided binding
function createDom(vnode: VNode, dom: DomBinding): any {
  if (isText(vnode)) {
    return dom.createTextNode(vnode.text);
  }
  const el = dom.createElement(vnode.tag);
  for (const [name, value] of Object.entries(vnode.attrs)) {
    dom.setAttribute(el, name, value);
  }
  for (const child of vnode.children) {
    dom.appendChild(el, createDom(child, dom));
  }
  return el;
}

function walk(oldNode: any, newNode: VNode | null, parent: any, patches: Patch[]): void {
  if (!oldNode && newNode) {
    // Insert new node
    patches.push((dom) => {
      if (!parent) return;
      dom.appendChild(parent, createDom(newNode, dom));
    });
    return;
  }

  if (oldNode && !newNode) {
    // Remove old node
    patches.push((dom) => {
      if (!parent) return;
      dom.removeChild(parent, oldNode);
    });
    return;
  }

  if (!oldNode || !newNode) {
    return;
  }

  if (isText(oldNode) && isText(newNode)) {
    if (oldNode.text !== newNode.text) {
      patches.push((dom) => dom.setText(oldNode, newNode.text));
    }
    return;
  }

  if (isElement(oldNode) && isElement(newNode) && oldNode.tag === newNode.tag) {
    // Attributes
    for (const [name, value] of Object.entries(newNode.attrs)) {
      if (oldNode.attrs[name] !== value) {
        patches.push((dom) => dom.setAttribute(oldNode, name, value));
      }
    }
    for (const name of Object.keys(oldNode.attrs)) {
      if (!(name in newNode.attrs)) {
        patches.push((dom) => dom.removeAttribute(oldNode, name));
      }
    }

    const max = Math.max(oldNode.children.length, newNode.children.length);
    for (let i = 0; i < max; i++) {
      walk(oldNode.children[i] ?? null, newNode.children[i] ?? null, oldNode, patches);
    }
    return;
  }

  // Nodes are different; replace
  patches.push((dom) => {
    if (!parent) return;
    const newDom = createDom(newNode, dom);
    dom.insertBefore(parent, newDom, oldNode);
    dom.removeChild(parent, oldNode);
  });
}

export function diff(oldVNode: VNode | null, newVNode: VNode | null): Patch[] {
  const patches: Patch[] = [];
  walk(oldVNode, newVNode, null, patches);
  return patches;
}

export function applyPatches(patches: Patch[], dom: DomBinding): void {
  for (const patch of patches) {
    patch(dom);
  }
}
