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

The `VNode` family of types is intentionally opaque: a binding may use native DOM objects, numeric handles, or even string IDs. The active binding is registered at runtime via `setDomBinding` and retrieved with `getDomBinding`. This indirection lets components compile once and run in different environments without embedding environment-specific logic.

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
- Defining the exact shape and lifetime of the virtual DOM nodes.
- Error boundaries or handling rendering failures.

## Browser DOM Binding

Call `initBrowserDomBinding()` in a browser environment to register the builtin DOM implementation backed by the global `document`. The binding manipulates real DOM nodes directly and thus requires a real browser environment. It will not function in runtimes without `document`, such as Node.js, unless a polyfill like `jsdom` is provided.
