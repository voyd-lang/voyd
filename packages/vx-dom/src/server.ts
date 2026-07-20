import { callComponentFn } from "./memory.js";
import {
  childNamespace,
  elementNamespace,
  normalizeRenderFrame,
  type MarkupNamespace,
  validateCssPropertyName,
  validateCssPropertyValue,
  validateDomPropertyName,
  validateDomPropertyValue,
  validateHtmlAttributeName,
  validateHtmlTagName,
  validateSvgAttributeName,
  validateSvgTagName,
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
const newlineStrippingTags = new Set(["listing", "pre", "textarea"]);
const rawTextTags = new Set(["script", "style"]);
const disableableTags = new Set([
  "button", "fieldset", "input", "optgroup", "option", "select", "textarea",
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
  return renderNode(vnode);
}

function renderNode(
  vnode: VNode,
  rawTextTag?: string,
  parentNamespace: MarkupNamespace = "html",
): string {
  if (vnode.kind === "text") {
    return rawTextTag ? renderRawText(vnode.value, rawTextTag) : escapeText(vnode.value);
  }
  if (vnode.kind === "fragment") {
    return vnode.children
      .map((child) => renderNode(child, rawTextTag, parentNamespace))
      .join("");
  }
  if (rawTextTag) {
    throw new Error(`vx-dom/server: ${rawTextTag} elements may only contain text`);
  }

  const namespace = elementNamespace(vnode.tag, parentNamespace);
  if (namespace === "svg") {
    validateSvgTagName(vnode.tag, "server.tag");
  } else {
    validateHtmlTagName(vnode.tag, "server.tag");
    validateTextareaValue(vnode);
  }
  const attrs = renderAttrs(vnode, namespace);
  if (namespace === "html" && voidTags.has(vnode.tag)) return `<${vnode.tag}${attrs}>`;
  const childRawTextTag = namespace === "html" && rawTextTags.has(vnode.tag)
    ? vnode.tag
    : undefined;
  const childrenNamespace = childNamespace(vnode.tag, namespace);
  const children = (vnode.children ?? [])
    .map((child) => renderNode(child, childRawTextTag, childrenNamespace))
    .join("");
  const leadingNewline = namespace === "html" &&
      newlineStrippingTags.has(vnode.tag) && children.startsWith("\n")
    ? "\n"
    : "";
  return `<${vnode.tag}${attrs}>${leadingNewline}${children}</${vnode.tag}>`;
}

function renderRawText(value: string, tag: string): string {
  if (value.includes("\0") || value.includes("\r")) {
    throw new Error(`vx-dom/server: ${tag} text contains a character HTML cannot preserve`);
  }
  if (value.toLowerCase().includes(`</${tag}`)) {
    throw new Error(`vx-dom/server: ${tag} text contains its closing delimiter`);
  }
  return value;
}

function renderAttrs(
  vnode: Extract<VNode, { kind: "element" }>,
  namespace: MarkupNamespace,
): string {
  const attrs = { ...(vnode.attrs ?? {}) };
  Object.entries(vnode.props ?? {}).forEach(([key, value]) => {
    validateDomPropertyName(key, `server.props.${key}`);
    validateDomPropertyValue(key, value, `server.props.${key}`);
    validateSsrProperty(vnode.tag, key, value);
    if (vnode.tag === "textarea" && key === "value") return;
    attrs[key] = value;
  });
  const style = Object.entries(vnode.styles ?? {})
    .map(([key, value]) => {
      validateCssPropertyName(key, `server.styles.${key}`);
      validateCssPropertyValue(value, `server.styles.${key}`);
      return `${key}: ${value}`;
    })
    .join("; ");
  if (style) attrs.style = style;

  return Object.entries(attrs)
    .flatMap(([key, value]) => {
      if (key === "key" || value == null || value === false) return [];
      if (namespace === "svg") {
        validateSvgAttributeName(key, `server.attrs.${key}`);
      } else {
        validateHtmlAttributeName(key, `server.attrs.${key}`);
      }
      if (value === true) return [` ${key}`];
      return [` ${key}="${escapeAttribute(String(value))}"`];
    })
    .join("");
}

function validateSsrProperty(tag: string, property: string, value: unknown): void {
  if (property === "value" && (tag === "input" || (tag === "textarea" && typeof value === "string"))) {
    return;
  }
  if (property === "checked" && tag === "input") return;
  if (property === "disabled" && disableableTags.has(tag)) {
    return;
  }
  throw new Error(`vx-dom/server: property ${property} has no stable SSR representation on <${tag}>`);
}

function validateTextareaValue(vnode: Extract<VNode, { kind: "element" }>): void {
  if (vnode.tag !== "textarea" || !Object.hasOwn(vnode.props ?? {}, "value")) return;
  const value = vnode.props?.value;
  if (typeof value !== "string" || textareaText(vnode.children ?? []) !== value) {
    throw new Error("vx-dom/server: textarea value must match its text children for hydration");
  }
}

function textareaText(children: VNode[]): string {
  return children.map((child) => {
    if (child.kind === "text") return child.value;
    if (child.kind === "fragment") return textareaText(child.children);
    throw new Error("vx-dom/server: textarea elements may only contain text");
  }).join("");
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/\r/g, "&#13;")
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
