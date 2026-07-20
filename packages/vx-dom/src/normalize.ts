import type {
  EventDescriptor,
  VNode,
  VxElementNode,
  VxRenderFrame,
} from "./types.js";

type LegacyElement = {
  name: string;
  attributes?: Record<string, unknown> | Array<[unknown, unknown]>;
  children?: unknown[];
};

export type MarkupNamespace = "html" | "svg";

const voidTags = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);

// The HTML parser rewrites these lowercase spellings when they occur in SVG
// markup. Accepting them would make SSR produce a different tree than a
// client-only createElementNS render.
const parserAdjustedSvgTagNames = new Set([
  "altglyph", "altglyphdef", "altglyphitem", "animatecolor", "animatemotion",
  "animatetransform", "clippath", "feblend", "fecolormatrix",
  "fecomponenttransfer", "fecomposite", "feconvolvematrix",
  "fediffuselighting", "fedisplacementmap", "fedistantlight", "feflood",
  "fefunca", "fefuncb", "fefuncg", "fefuncr", "fegaussianblur", "feimage",
  "femerge", "femergenode", "femorphology", "feoffset", "fepointlight",
  "fespecularlighting", "fespotlight", "fetile", "feturbulence",
  "foreignobject", "glyphref", "lineargradient", "radialgradient", "textpath",
]);

export function normalizeRenderFrame(input: unknown): VxRenderFrame {
  const record = toRecord(input);
  if (record && "version" in record) {
    if (record.version !== 1) {
      throw new Error(`vx-dom: unsupported VX render frame version ${String(record.version)}`);
    }
    return { version: 1, root: normalizeVersionedVNode(record.root, "root", "html") };
  }

  return { version: 1, root: normalizeVNode(input) };
}

export function validateHtmlTagName(value: string, path = "tag"): void {
  if (!/^[a-z][a-z0-9:-]*$/.test(value)) {
    throw new Error(`vx-dom: invalid HTML tag name at ${path}: ${JSON.stringify(value)}`);
  }
}

export function validateHtmlAttributeName(value: string, path = "attribute"): void {
  if (/[A-Z]/.test(value) || !/^[^\s"'/>=\u0000-\u001f\u007f]+$/.test(value)) {
    throw new Error(`vx-dom: invalid HTML attribute name at ${path}: ${JSON.stringify(value)}`);
  }
}

export function validateSvgTagName(value: string, path = "tag"): void {
  if (
    !/^[A-Za-z][A-Za-z0-9:-]*$/.test(value) ||
    parserAdjustedSvgTagNames.has(value)
  ) {
    throw new Error(`vx-dom: invalid SVG tag name at ${path}: ${JSON.stringify(value)}`);
  }
}

export function validateSvgAttributeName(value: string, path = "attribute"): void {
  if (!/^[^\s"'/>=\u0000-\u001f\u007f]+$/.test(value)) {
    throw new Error(`vx-dom: invalid SVG attribute name at ${path}: ${JSON.stringify(value)}`);
  }
}

export function elementNamespace(
  tag: string,
  parentNamespace: MarkupNamespace,
): MarkupNamespace {
  return parentNamespace === "svg" || tag === "svg" ? "svg" : "html";
}

export function childNamespace(
  tag: string,
  namespace: MarkupNamespace,
): MarkupNamespace {
  return namespace === "svg" && tag === "foreignObject" ? "html" : namespace;
}

export function validateCssPropertyName(value: string, path = "style"): void {
  if (!/^(--[a-zA-Z0-9_-]+|-[a-zA-Z][a-zA-Z0-9-]*|[a-zA-Z][a-zA-Z0-9-]*)$/.test(value)) {
    throw new Error(`vx-dom: invalid CSS property name at ${path}: ${JSON.stringify(value)}`);
  }
}

export function validateCssPropertyValue(value: string, path = "style"): void {
  if (/[;!\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`vx-dom: invalid CSS property value at ${path}: ${JSON.stringify(value)}`);
  }
}

export function validateDomPropertyName(value: string, path = "property"): void {
  if (value !== "value" && value !== "checked" && value !== "disabled") {
    throw new Error(`vx-dom: unsupported DOM property at ${path}: ${JSON.stringify(value)}`);
  }
}

export function validateDomPropertyValue(
  name: string,
  value: unknown,
  path = "property",
): void {
  const valid = name === "value"
    ? typeof value === "string" || typeof value === "number"
    : typeof value === "boolean";
  if (!valid) {
    throw new Error(`vx-dom: invalid DOM property value at ${path}: ${JSON.stringify(value)}`);
  }
}

export function normalizeVNode(input: unknown): VNode {
  return normalizeVNodeInNamespace(input, "html");
}

function normalizeVNodeInNamespace(
  input: unknown,
  namespace: MarkupNamespace,
): VNode {
  if (input == null) return { kind: "fragment", children: [] };
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    return { kind: "text", value: String(input) };
  }
  if (Array.isArray(input)) {
    return {
      kind: "fragment",
      children: input.map((child) => normalizeVNodeInNamespace(child, namespace)),
    };
  }
  const record = toRecord(input);
  if (!record) {
    return { kind: "text", value: String(input) };
  }

  if (record.kind === "text") {
    return {
      kind: "text",
      value: String(record.value ?? ""),
      key: optionalString(record.key),
    };
  }
  if (record.kind === "fragment") {
    return {
      kind: "fragment",
      key: optionalString(record.key),
      children: normalizeChildren(record.children, namespace),
    };
  }
  if (record.kind === "element") {
    return normalizeElement(record, namespace);
  }
  if (record.kind === "map") {
    const child = normalizeVNodeInNamespace(record.child, namespace);
    return typeof record.handlerId === "number"
      ? applyVNodeMessageMap(child, record.handlerId)
      : child;
  }
  if (typeof record.name === "string") {
    return normalizeLegacyElement(record as LegacyElement, namespace);
  }

  return { kind: "text", value: String(input) };
}

function normalizeElement(
  input: Record<string, unknown>,
  parentNamespace: MarkupNamespace,
): VxElementNode {
  const tag = typeof input.tag === "string" && input.tag ? input.tag : "div";
  const namespace = elementNamespace(tag, parentNamespace);
  validateTagName(tag, namespace);
  const children = normalizeChildren(input.children, childNamespace(tag, namespace));
  validateVoidElementChildren(tag, children, "element", namespace);
  return {
    kind: "element",
    tag,
    key: optionalString(input.key),
    attrs: normalizeValidatedRecord(
      input.attrs,
      "element.attrs",
      attributeNameValidator(namespace),
    ),
    props: normalizeValidatedProps(input.props, "element.props"),
    styles: normalizeValidatedStyles(input.styles, "element.styles"),
    events: normalizeEvents(input.events),
    children,
  };
}

function normalizeLegacyElement(
  input: LegacyElement,
  parentNamespace: MarkupNamespace,
): VxElementNode {
  const attributes = normalizeLegacyAttributes(input.attributes);
  const tag = input.name || "div";
  const namespace = elementNamespace(tag, parentNamespace);
  validateTagName(tag, namespace, "legacy.name");
  Object.keys(attributes ?? {}).forEach((key) =>
    attributeNameValidator(namespace)(key, `legacy.attributes.${key}`)
  );
  const children = normalizeChildren(input.children, childNamespace(tag, namespace));
  validateVoidElementChildren(tag, children, "legacy element", namespace);
  return {
    kind: "element",
    tag,
    key: optionalString(attributes?.key),
    attrs: attributes,
    children,
  };
}

function normalizeChildren(input: unknown, namespace: MarkupNamespace): VNode[] {
  return Array.isArray(input)
    ? input.map((child) => normalizeVNodeInNamespace(child, namespace))
    : [];
}

function normalizeLegacyAttributes(
  input: LegacyElement["attributes"],
): Record<string, unknown> | undefined {
  if (Array.isArray(input)) {
    const attrs = Object.fromEntries(
      input
        .filter((entry): entry is [unknown, unknown] => Array.isArray(entry) && entry.length >= 2)
        .map(([key, value]) => [String(key), value]),
    );
    return Object.keys(attrs).length > 0 ? attrs : undefined;
  }
  return normalizeRecord(input);
}

function normalizeRecord(input: unknown): Record<string, unknown> | undefined {
  const record = toRecord(input);
  if (!record) return undefined;
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeEvents(input: unknown): EventDescriptor[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const events = input.flatMap((entry) => {
    const record = toRecord(entry);
    if (!isEventDescriptor(record)) return [];
    const options = normalizeEventOptions(record.options);
    const handlerId = typeof record.handlerId === "number"
      ? record.handlerId
      : undefined;
    const hasMessage = Object.hasOwn(record, "message");
    return [
      {
        kind: "event" as const,
        event: record.event,
        ...(handlerId !== undefined ? { handlerId } : {}),
        ...(hasMessage ? { message: record.message } : {}),
        ...(options ? { options } : {}),
      },
    ];
  });
  return events.length > 0 ? events : undefined;
}

function normalizeVersionedVNode(
  input: unknown,
  path: string,
  namespace: MarkupNamespace,
): VNode {
  const record = toRecord(input);
  if (!record) {
    throw new Error(`vx-dom: invalid VX frame at ${path}: expected node object`);
  }

  if (record.kind === "text") {
    if (typeof record.value !== "string" && typeof record.value !== "number" && typeof record.value !== "boolean") {
      throw new Error(`vx-dom: invalid VX frame at ${path}.value: expected text value`);
    }
    return {
      kind: "text",
      value: String(record.value),
      key: strictOptionalString(record.key, `${path}.key`),
    };
  }

  if (record.kind === "fragment") {
    return {
      kind: "fragment",
      key: strictOptionalString(record.key, `${path}.key`),
      children: normalizeVersionedChildren(record.children, `${path}.children`, namespace),
    };
  }

  if (record.kind === "element") {
    return normalizeVersionedElement(record, path, namespace);
  }

  if (record.kind === "map") {
    if (typeof record.handlerId !== "number") {
      throw new Error(`vx-dom: invalid VX frame at ${path}.handlerId: expected number`);
    }
    return applyVNodeMessageMap(
      normalizeVersionedVNode(
        readRequiredField(record, "child", path),
        `${path}.child`,
        namespace,
      ),
      record.handlerId,
    );
  }

  throw new Error(`vx-dom: invalid VX frame at ${path}.kind: expected text, fragment, element, or map`);
}

function normalizeVersionedElement(
  input: Record<string, unknown>,
  path: string,
  parentNamespace: MarkupNamespace,
): VxElementNode {
  if (typeof input.tag !== "string" || input.tag.length === 0) {
    throw new Error(`vx-dom: invalid VX frame at ${path}.tag: expected non-empty string`);
  }
  const namespace = elementNamespace(input.tag, parentNamespace);
  validateTagName(input.tag, namespace, `${path}.tag`);
  const children = normalizeVersionedChildren(
    input.children,
    `${path}.children`,
    childNamespace(input.tag, namespace),
  );
  validateVoidElementChildren(input.tag, children, path, namespace);
  return {
    kind: "element",
    tag: input.tag,
    key: strictOptionalString(input.key, `${path}.key`),
    attrs: normalizeValidatedRecord(
      input.attrs,
      `${path}.attrs`,
      attributeNameValidator(namespace),
    ),
    props: normalizeValidatedProps(input.props, `${path}.props`),
    styles: normalizeValidatedStyles(input.styles, `${path}.styles`),
    events: normalizeVersionedEvents(input.events, `${path}.events`),
    children,
  };
}

function normalizeValidatedProps(
  input: unknown,
  path: string,
): Record<string, unknown> | undefined {
  const props = normalizeValidatedRecord(input, path);
  if (!props) return undefined;
  Object.entries(props).forEach(([name, value]) => {
    if (name === "value" || name === "checked" || name === "disabled") {
      validateDomPropertyValue(name, value, `${path}.${name}`);
    }
  });
  return props;
}

function normalizeVersionedChildren(
  input: unknown,
  path: string,
  namespace: MarkupNamespace,
): VNode[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new Error(`vx-dom: invalid VX frame at ${path}: expected array`);
  }
  return input.map((child, index) =>
    normalizeVersionedVNode(child, `${path}[${index}]`, namespace)
  );
}

function validateVoidElementChildren(
  tag: string,
  children: VNode[],
  path: string,
  namespace: MarkupNamespace,
): void {
  if (namespace === "html" && voidTags.has(tag) && children.length > 0) {
    throw new Error(`vx-dom: void element at ${path} cannot have children`);
  }
}

function validateTagName(
  tag: string,
  namespace: MarkupNamespace,
  path = "tag",
): void {
  const validate = namespace === "svg" ? validateSvgTagName : validateHtmlTagName;
  validate(tag, path);
}

function attributeNameValidator(
  namespace: MarkupNamespace,
): (name: string, path: string) => void {
  return namespace === "svg" ? validateSvgAttributeName : validateHtmlAttributeName;
}

function normalizeValidatedRecord(
  input: unknown,
  path: string,
  validateName?: (name: string, path: string) => void,
): Record<string, unknown> | undefined {
  if (input === undefined) return undefined;
  const record = toRecord(input);
  if (!record) {
    throw new Error(`vx-dom: invalid VX frame at ${path}: expected object`);
  }
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  entries.forEach(([key]) => validateName?.(key, `${path}.${key}`));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeValidatedStyles(input: unknown, path: string): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  const record = normalizeValidatedRecord(input, path, validateCssPropertyName);
  if (!record) return undefined;
  const entries = Object.entries(record)
    .filter(([, value]) => value != null)
    .map(([key, value]) => {
      const stringValue = String(value);
      validateCssPropertyValue(stringValue, `${path}.${key}`);
      return [key, stringValue];
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeVersionedEvents(input: unknown, path: string): EventDescriptor[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    throw new Error(`vx-dom: invalid VX frame at ${path}: expected array`);
  }
  const events = input.map((entry, index) => {
    const eventPath = `${path}[${index}]`;
    const record = toRecord(entry);
    if (!record || record.kind !== "event") {
      throw new Error(`vx-dom: invalid VX frame at ${eventPath}.kind: expected event`);
    }
    if (typeof record.event !== "string" || record.event.length === 0) {
      throw new Error(`vx-dom: invalid VX frame at ${eventPath}.event: expected non-empty string`);
    }
    const handlerId = typeof record.handlerId === "number" ? record.handlerId : undefined;
    const hasMessage = Object.hasOwn(record, "message");
    if (handlerId === undefined && !hasMessage) {
      throw new Error(`vx-dom: invalid VX frame at ${eventPath}: expected handlerId or message`);
    }
    const mapHandlerIds = normalizeMapHandlerIds(record.mapHandlerIds, `${eventPath}.mapHandlerIds`);
    const options = normalizeEventOptions(record.options);
    return {
      kind: "event" as const,
      event: record.event,
      ...(handlerId !== undefined ? { handlerId } : {}),
      ...(hasMessage ? { message: record.message } : {}),
      ...(mapHandlerIds ? { mapHandlerIds } : {}),
      ...(options ? { options } : {}),
    };
  });
  return events.length > 0 ? events : undefined;
}

function applyVNodeMessageMap(vnode: VNode, handlerId: number): VNode {
  if (vnode.kind === "text") return vnode;
  if (vnode.kind === "fragment") {
    return {
      ...vnode,
      children: vnode.children.map((child) => applyVNodeMessageMap(child, handlerId)),
    };
  }
  return {
    ...vnode,
    events: vnode.events?.map((event) => ({
      ...event,
      mapHandlerIds: [...(event.mapHandlerIds ?? []), handlerId],
    })),
    children: vnode.children?.map((child) => applyVNodeMessageMap(child, handlerId)),
  };
}

function readRequiredField(input: Record<string, unknown>, field: string, path: string): unknown {
  if (!Object.hasOwn(input, field)) {
    throw new Error(`vx-dom: invalid VX frame at ${path}.${field}: missing required field`);
  }
  return input[field];
}

function normalizeMapHandlerIds(input: unknown, path: string): number[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    throw new Error(`vx-dom: invalid VX frame at ${path}: expected array`);
  }
  const ids = input.map((entry, index) => {
    if (typeof entry !== "number") {
      throw new Error(`vx-dom: invalid VX frame at ${path}[${index}]: expected number`);
    }
    return entry;
  });
  return ids.length > 0 ? ids : undefined;
}

function strictOptionalString(input: unknown, path: string): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "string" || typeof input === "number") return String(input);
  throw new Error(`vx-dom: invalid VX frame at ${path}: expected string key`);
}

function isEventDescriptor(input: unknown): input is EventDescriptor {
  const record = toRecord(input);
  return (
    !!record &&
    record.kind === "event" &&
    typeof record.event === "string" &&
    (
      typeof record.handlerId === "number" ||
      Object.hasOwn(record, "message")
    )
  );
}

function normalizeEventOptions(input: unknown): EventDescriptor["options"] {
  const record = toRecord(input);
  if (!record) return undefined;
  const options = {
    preventDefault: optionalBool(record.preventDefault),
    stopPropagation: optionalBool(record.stopPropagation),
    capture: optionalBool(record.capture),
    passive: optionalBool(record.passive),
  };
  return Object.values(options).some((value) => value !== undefined)
    ? options
    : undefined;
}

function optionalBool(input: unknown): boolean | undefined {
  return typeof input === "boolean" ? input : undefined;
}

function optionalString(input: unknown): string | undefined {
  return typeof input === "string" || typeof input === "number"
    ? String(input)
    : undefined;
}

function toRecord(input: unknown): Record<string, unknown> | undefined {
  if (input instanceof Map) {
    return Object.fromEntries(input.entries()) as Record<string, unknown>;
  }
  return isRecord(input) ? input : undefined;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}
