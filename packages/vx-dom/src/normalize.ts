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

export function normalizeRenderFrame(input: unknown): VxRenderFrame {
  const record = toRecord(input);
  if (record && "version" in record) {
    if (record.version !== 1) {
      throw new Error(`vx-dom: unsupported VX render frame version ${String(record.version)}`);
    }
    return { version: 1, root: normalizeVNode(record.root) };
  }

  return { version: 1, root: normalizeVNode(input) };
}

export function normalizeVNode(input: unknown): VNode {
  if (input == null) return { kind: "fragment", children: [] };
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    return { kind: "text", value: String(input) };
  }
  if (Array.isArray(input)) {
    return { kind: "fragment", children: input.map(normalizeVNode) };
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
      children: normalizeChildren(record.children),
    };
  }
  if (record.kind === "element") {
    return normalizeElement(record);
  }
  if (record.kind === "map") {
    return normalizeVNode(record.child);
  }
  if (typeof record.name === "string") {
    return normalizeLegacyElement(record as LegacyElement);
  }

  return { kind: "text", value: String(input) };
}

function normalizeElement(input: Record<string, unknown>): VxElementNode {
  return {
    kind: "element",
    tag: typeof input.tag === "string" && input.tag ? input.tag : "div",
    key: optionalString(input.key),
    attrs: normalizeRecord(input.attrs),
    props: normalizeRecord(input.props),
    styles: normalizeStringRecord(input.styles),
    events: normalizeEvents(input.events),
    children: normalizeChildren(input.children),
  };
}

function normalizeLegacyElement(input: LegacyElement): VxElementNode {
  const attributes = normalizeLegacyAttributes(input.attributes);
  return {
    kind: "element",
    tag: input.name || "div",
    key: optionalString(attributes?.key),
    attrs: attributes,
    children: normalizeChildren(input.children),
  };
}

function normalizeChildren(input: unknown): VNode[] {
  return Array.isArray(input) ? input.map(normalizeVNode) : [];
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

function normalizeStringRecord(input: unknown): Record<string, string> | undefined {
  const record = toRecord(input);
  if (!record) return undefined;
  const entries = Object.entries(record)
    .filter(([, value]) => value != null)
    .map(([key, value]) => [key, String(value)]);
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
