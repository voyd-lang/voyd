import { decode } from "@msgpack/msgpack";

export type VoydComponentFn = () => number;

export type RenderOptions =
  | { instance: WebAssembly.Instance; memory?: undefined }
  | { instance?: undefined; memory: WebAssembly.Memory };

/**
 * Render a compiled Voyd component onto a DOM element.
 *
 * componentFn: function exported from a WebAssembly.Instance that writes a
 *   MsgPack-encoded element tree to linear memory and returns its byte length.
 * container: HTMLElement to render into (its contents are replaced).
 * options: supply either the WebAssembly instance or memory for decoding.
 */
export function render(
  componentFn: VoydComponentFn,
  container: HTMLElement,
  options: RenderOptions
) {
  const memory = resolveMemory(options);
  if (!memory) {
    throw new Error(
      "vsx-dom/client: Unable to resolve WebAssembly memory. Pass { instance } or { memory }."
    );
  }

  const length = componentFn();
  const view = memory.buffer.slice(0, length);
  const tree = decode(view) as MsgPackNode;

  const dom = toDom(tree);
  container.textContent = "";
  container.appendChild(dom);
}

function resolveMemory(options: RenderOptions) {
  if ("memory" in options && options.memory) return options.memory;
  if ("instance" in options && options.instance?.exports) {
    const mem = (options.instance.exports as any)["main_memory"];
    if (isMemory(mem)) return mem as WebAssembly.Memory;
  }
  return undefined;
}

function isMemory(maybe: unknown): maybe is WebAssembly.Memory {
  return !!maybe && typeof maybe === "object" && "grow" in (maybe as any);
}

type MsgPackElement = {
  name: string;
  attributes?: Record<string, unknown>;
  children?: MsgPackNode[];
};

// Allow nested arrays of nodes (fragments) in the tree
type MsgPackNode =
  | MsgPackElement
  | string
  | number
  | null
  | undefined
  | MsgPackNode[];

function toDom(node: MsgPackNode): Node {
  if (node == null) return document.createDocumentFragment();
  if (Array.isArray(node)) {
    const frag = document.createDocumentFragment();
    for (const child of node) frag.appendChild(toDom(child));
    return frag;
  }
  if (typeof node === "string" || typeof node === "number") {
    return document.createTextNode(String(node));
  }

  const el = document.createElement(node.name || "div");

  const attrs = node.attributes || {};
  for (const key of Object.keys(attrs)) {
    const val = (attrs as any)[key];
    if (val == null) continue;
    el.setAttribute(key, String(val));
  }

  const children = node.children || [];
  for (const child of children) {
    el.appendChild(toDom(child));
  }

  return el;
}
