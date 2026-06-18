import { callComponentFn } from "./memory.js";
import {
  normalizeRenderFrame,
  validateCssPropertyName,
  validateHtmlAttributeName,
  validateHtmlTagName,
} from "./normalize.js";
import type { CallOptions, VNode, VxRenderFrame, VoydComponentFn } from "./types.js";

export type ServerRenderResult = {
  html: string;
  hydrationData: string;
  head?: {
    title?: string;
    meta?: Array<{ name: string; content: string }>;
  };
};

export type RenderVxToStringOptions = {
  frame?: unknown;
  tree?: unknown;
  componentFn?: VoydComponentFn;
  callOptions?: CallOptions;
  wasm?: Uint8Array | WebAssembly.Module;
  imports?: WebAssembly.Imports;
  instance?: WebAssembly.Instance;
  exportName?: string;
  head?: ServerRenderResult["head"];
};

const voidTags = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

export async function renderVxToString(
  options: RenderVxToStringOptions,
): Promise<ServerRenderResult> {
  const instance = await resolveInstanceForRender(options);
  const source =
    options.frame ??
    options.tree ??
    (options.componentFn && options.callOptions
      ? callComponentFn(options.componentFn, options.callOptions)
      : instance
        ? callComponentFn(
          exportedComponent(instance, options.exportName ?? "main"),
          { instance },
        )
      : undefined);
  if (source === undefined) {
    throw new Error("vx-dom/server: renderVxToString requires frame, tree, componentFn, instance, or wasm");
  }

  const frame = normalizeRenderFrame(source);
  return {
    html: renderNodeToString(frame.root),
    hydrationData: JSON.stringify(frame),
    head: options.head,
  };
}

export function renderNodeToString(vnode: VNode): string {
  if (vnode.kind === "text") return escapeText(vnode.value);
  if (vnode.kind === "fragment") return vnode.children.map(renderNodeToString).join("");

  validateHtmlTagName(vnode.tag, "server.tag");
  const attrs = renderAttrs(vnode);
  if (voidTags.has(vnode.tag)) return `<${vnode.tag}${attrs}>`;
  const children = (vnode.children ?? []).map(renderNodeToString).join("");
  return `<${vnode.tag}${attrs}>${children}</${vnode.tag}>`;
}

function renderAttrs(vnode: Extract<VNode, { kind: "element" }>): string {
  const attrs = { ...(vnode.attrs ?? {}) };
  Object.entries(vnode.props ?? {}).forEach(([key, value]) => {
    if (key === "className") attrs.class = value;
    else attrs[key] = value;
  });
  const style = Object.entries(vnode.styles ?? {})
    .map(([key, value]) => {
      validateCssPropertyName(key, `server.styles.${key}`);
      return `${key}: ${value}`;
    })
    .join("; ");
  if (style) attrs.style = style;

  return Object.entries(attrs)
    .flatMap(([key, value]) => {
      if (key === "key" || value == null || value === false) return [];
      validateHtmlAttributeName(key, `server.attrs.${key}`);
      if (value === true) return [` ${key}`];
      return [` ${key}="${escapeAttribute(String(value))}"`];
    })
    .join("");
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}

async function resolveInstanceForRender(
  options: Pick<RenderVxToStringOptions, "frame" | "tree" | "componentFn" | "instance" | "wasm" | "imports">,
): Promise<WebAssembly.Instance | undefined> {
  if (options.frame !== undefined || options.tree !== undefined || options.componentFn) return undefined;
  if (options.instance) return options.instance;
  if (!options.wasm) return undefined;
  if (options.wasm instanceof WebAssembly.Module) {
    return WebAssembly.instantiate(options.wasm, options.imports ?? {});
  }
  const result = (await WebAssembly.instantiate(
    options.wasm as BufferSource,
    options.imports ?? {},
  )) as WebAssembly.WebAssemblyInstantiatedSource;
  return result.instance;
}

function exportedComponent(
  instance: WebAssembly.Instance,
  exportName: string,
): VoydComponentFn {
  const entry = instance.exports[exportName];
  if (typeof entry !== "function") {
    throw new Error(`vx-dom/server: WebAssembly export ${exportName} is not a function`);
  }
  return entry as VoydComponentFn;
}

export type { VxRenderFrame };
