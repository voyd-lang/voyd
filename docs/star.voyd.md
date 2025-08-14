# star.voyd

## Goals and Terminology

- **star.voyd**: a React-like framework for the Voyd language.
- **Functional components**: pure functions mapping props to DOM structures.
- **No state or effects**: initial MVP omits `useState`, `useEffect`, or other side-effect primitives. Components are rendered solely from their inputs.

## DOM Binding Requirements

- **Browser binding**: efficient interface between WebAssembly and the browser's DOM for client-side rendering.
- **jsdom binding**: parallel implementation using `jsdom` to enable server-side rendering during compilation or tests.
- Both bindings expose a common interface so components compile once and run in both environments.

## DOM Binding Interface

To keep rendering portable, both the browser and `jsdom` implementations provide the same set of DOM primitives:

```ts
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

export function setDomBinding(binding: DomBinding): void;
export function getDomBinding(): DomBinding;
```

These TypeScript methods map to Voyd declarations in the `dom` namespace:

| TypeScript | Voyd |
| ---------- | ---- |
| `createElement(tag: string): VElement` | `dom.create_element(tag: string) -> VElement` |
| `createTextNode(text: string): VText` | `dom.create_text_node(text: string) -> VText` |
| `setAttribute(el: VElement, name: string, value: string): void` | `dom.set_attribute(el: VElement, name: string, value: string) -> void` |
| `removeAttribute(el: VElement, name: string): void` | `dom.remove_attribute(el: VElement, name: string) -> void` |
| `appendChild(parent: VNode, child: VNode): void` | `dom.append_child(parent: VNode, child: VNode) -> void` |
| `removeChild(parent: VNode, child: VNode): void` | `dom.remove_child(parent: VNode, child: VNode) -> void` |
| `insertBefore(parent: VNode, child: VNode, ref: VNode \| null): void` | `dom.insert_before(parent: VNode, child: VNode, ref: VNode \| Null) -> void` |
| `setText(node: VNode, text: string): void` | `dom.set_text(node: VNode, text: string) -> void` |
## Virtual DOM Node Structure

Star.voyd represents the DOM as a tree of plain objects that can be serialized easily for WebAssembly interop. Nodes are tagged with a numeric `kind` to keep the shape compact:

```ts
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
): VElement;

export function text(content: string): VText;
```

Example usage:

```ts
import { element, text } from "../src/star/vdom.js";

const tree = element("div", { class: "greeting" }, [
  text("hello world"),
]);
```


## html Macro

The `html` macro transforms inline HTML syntax into calls that construct
virtual DOM nodes.

```voyd
use ::star macros all

fn view() -> VNode
  html <div class="greeting">hello</div>
```

Expands to:

```voyd
element("div", dict("class" "greeting"), (array text("hello")))
```

## Server-side Rendering with jsdom

When running star.voyd on the server, `jsdom` provides the DOM implementation. Use the helper below to set up the binding:

```ts
import { initJsdomDomBinding } from "../src/star/dom-binding/jsdom.js";

const dom = initJsdomDomBinding();
// dom.window.document is ready for rendering
```

Install the dependency with:

```
npm install jsdom @types/jsdom
```

DOM bindings operate on opaque `VNode` values, which may be native DOM objects, numeric handles, or even string IDs. The active binding is registered at runtime via `setDomBinding` and retrieved with `getDomBinding`. This indirection lets components compile once and run in different environments without embedding environment-specific logic.

## Virtual DOM Expectations

- Maintain a minimal virtual representation of the DOM.
- On updates, diff the new virtual tree against the previous one and patch only the necessary nodes.
- The diff/patch workflow should aim for performance comparable to JavaScript React.

## MVP Scope

- Render functional components to browser DOM or `jsdom`.
- Support prop changes and re-rendering with efficient diffing.
- Exclude state management, side effects, and hooks.

## Open Questions / TODOs

- How to handle event listeners and cleanup without hooks.
- Strategy for hydration when rendering initially on the server.
- Error boundaries or handling rendering failures.

## Browser DOM Binding

Call `initBrowserDomBinding()` in a browser environment to register the builtin DOM implementation backed by the global `document`. The binding manipulates real DOM nodes directly and thus requires a real browser environment. It will not function in runtimes without `document`, such as Node.js, unless a polyfill like `jsdom` is provided.
