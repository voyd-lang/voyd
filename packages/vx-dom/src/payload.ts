import { decode as decodeMsgPack } from "@msgpack/msgpack";

const taskObserverProperty = Symbol.for("voyd.taskObserver");

export function decodeVxPayload(value: unknown): unknown {
  const decoded = decodeDataValue(value);
  const observer =
    value !== null && typeof value === "object"
      ? (value as Record<PropertyKey, unknown>)[taskObserverProperty]
      : undefined;
  if (
    typeof observer === "function" &&
    decoded !== null &&
    typeof decoded === "object"
  ) {
    Object.defineProperty(decoded, taskObserverProperty, {
      configurable: true,
      enumerable: false,
      value: observer,
    });
  }
  return decoded;
}

const decodeDataValue = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const variant =
    typeof value.$variant === "string"
      ? value.$variant
      : typeof value.tag === "string"
        ? value.tag
        : undefined;
  if (Array.isArray(value.fields) && variant === undefined) {
    return decodeDataFields(value.fields);
  }
  if (variant === undefined) {
    return Object.keys(value).length === 1 && Object.hasOwn(value, "node")
      ? decodeDataValue(value.node)
      : value;
  }
  switch (variant) {
    case "DataNull":
      return null;
    case "DataBool":
    case "DataI32":
    case "DataI64":
    case "DataF32":
    case "DataF64":
    case "DataString":
    case "DataBytes":
      return value.value;
    case "DataArray":
      return Array.isArray(value.values)
        ? value.values.map(decodeDataValue)
        : [];
    case "DataObject":
      return decodeDataFields(value.fields);
    case "DataVariant":
      return decodeDataValue({
        tag: value.name,
        ...decodeDataFields(value.fields),
      });
    case "CommandNone":
      return { type: "cmd", kind: "none" };
    case "CommandMessage":
      return {
        type: "cmd",
        kind: "message",
        value: decodeEncodedPayload(value.payload),
      };
    case "CommandBatch":
      return {
        type: "cmd",
        kind: "batch",
        children: Array.isArray(value.children)
          ? value.children.map(decodeDataValue)
          : [],
      };
    case "CommandMap":
      return {
        type: "cmd",
        kind: "map",
        child: decodeDataValue(value.child),
        handlerId: value.handler_id,
      };
    case "CommandRuntime":
      return {
        type: "cmd",
        kind: value.kind,
        ...(Object.hasOwn(value, "value")
          ? { value: decodeDataValue(value.value) }
          : {}),
      };
    case "CommandReadClipboard":
      return {
        type: "cmd",
        kind: "read_clipboard",
        handlerId: value.handler_ref,
      };
    case "CommandTask":
      return {
        type: "cmd",
        kind: "task",
        taskId: value.task_ref,
        handlerId: value.handler_ref,
      };
    case "CommandDelay":
      return {
        type: "cmd",
        kind: "delay",
        ms:
          typeof value.millis === "bigint"
            ? Number(value.millis)
            : value.millis,
        value: decodeEncodedPayload(value.payload),
      };
    case "CommandOwned": {
      const child = decodeDataValue(value.child);
      return isRecord(child)
        ? {
            ...child,
            __vxOwnedMapHandlerIds: [value.handler_ref],
          }
        : child;
    }
    case "CommandLegacy":
      return decodeDataValue(value.value);
    case "AttrString":
    case "AttrBool":
    case "AttrI32":
      return value.value;
    case "NamedAttr":
      return {
        kind: value.kind,
        name: value.name,
        value: decodeDataValue(value.value),
      };
    case "EventAttr":
      return {
        kind: "event",
        event: value.event,
        handlerId: value.handler_ref,
        ...(isRecord(value.options)
          ? { options: decodeEventOptions(value.options) }
          : {}),
      };
    case "HtmlText":
      return { kind: "text", value: value.value };
    case "HtmlFragment":
      return {
        kind: "fragment",
        children: decodeWireList(value.children, "HtmlWireEnd", "HtmlWireNext"),
      };
    case "HtmlElement":
      return decodeHtmlElement(value);
    case "HtmlKeyed": {
      const child = decodeDataValue(value.child);
      return isRecord(child) ? { ...child, key: value.key } : child;
    }
    case "HtmlMapped":
      return {
        kind: "map",
        child: decodeDataValue(value.child),
        handlerId: value.handler_ref,
      };
    case "HtmlFrame":
      return { version: value.version, root: decodeDataValue(value.root) };
    default:
      return value;
  }
};

const decodeHtmlElement = (value: Record<string, unknown>): unknown => {
  const attrs: Record<string, unknown> = {};
  const props: Record<string, unknown> = {};
  const styles: Record<string, unknown> = {};
  const events: unknown[] = [];
  const targetFor = (kind: unknown): Record<string, unknown> =>
    kind === "prop" ? props : kind === "style" ? styles : attrs;
  decodeWireList(value.attrs, "AttrWireEnd", "AttrWireNext").forEach(
    (entry) => {
      if (!isRecord(entry)) return;
      if (entry.kind === "event") {
        events.push(entry);
        return;
      }
      if (typeof entry.name === "string") {
        targetFor(entry.kind)[entry.name] = entry.value;
      }
    },
  );
  return {
    kind: "element",
    tag: value.element_name,
    children: decodeWireList(value.children, "HtmlWireEnd", "HtmlWireNext"),
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(Object.keys(props).length > 0 ? { props } : {}),
    ...(Object.keys(styles).length > 0 ? { styles } : {}),
    ...(events.length > 0 ? { events } : {}),
  };
};

const decodeWireList = (
  value: unknown,
  endTag: string,
  nextTag: string,
): unknown[] => {
  const out: unknown[] = [];
  let current = value;
  while (isRecord(current)) {
    const tag =
      typeof current.$variant === "string"
        ? current.$variant
        : typeof current.tag === "string"
          ? current.tag
          : undefined;
    if (tag === endTag) return out;
    if (tag !== nextTag) break;
    out.push(decodeDataValue(current.value));
    current = current.rest;
  }
  return out;
};

const decodeEventOptions = (
  value: Record<string, unknown>,
): Record<string, unknown> => ({
  ...(typeof value.prevent_default === "boolean"
    ? { preventDefault: value.prevent_default }
    : {}),
  ...(typeof value.stop_propagation === "boolean"
    ? { stopPropagation: value.stop_propagation }
    : {}),
  ...(typeof value.capture === "boolean" ? { capture: value.capture } : {}),
  ...(typeof value.passive === "boolean" ? { passive: value.passive } : {}),
  ...(typeof value.pointer_capture === "boolean"
    ? { pointerCapture: value.pointer_capture }
    : {}),
});

const decodeEncodedPayload = (value: unknown): unknown => {
  if (!isRecord(value) || !(value.bytes instanceof Uint8Array)) {
    throw new Error("vx-dom: encoded payload is missing immutable bytes");
  }
  if (
    typeof value.fingerprint !== "string" ||
    value.fingerprint.length !== 64
  ) {
    throw new Error("vx-dom: encoded payload is missing its DTO fingerprint");
  }
  return decodeMsgPack(value.bytes, { useBigInt64: true });
};

const decodeDataFields = (value: unknown): Record<string, unknown> => {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(
    value.flatMap((field) =>
      isRecord(field) && typeof field.name === "string"
        ? [[field.name, decodeDataValue(field.value)] as const]
        : [],
    ),
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
