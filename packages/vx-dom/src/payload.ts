const taskObserverProperty = Symbol.for("voyd.taskObserver");

export type VxPayloadDecoder = (
  bytes: Uint8Array,
  fingerprint: string,
) => unknown;

export function decodeVxPayload(
  value: unknown,
  decodePayload?: VxPayloadDecoder,
): unknown {
  const decoded = decodeDataValue(value, decodePayload);
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

const decodeDataValue = (
  value: unknown,
  decodePayload?: VxPayloadDecoder,
): unknown => {
  if (!isRecord(value)) return value;
  const variant =
    typeof value.$variant === "string"
      ? value.$variant
      : typeof value.tag === "string"
        ? value.tag
        : undefined;
  if (variant === undefined) {
    return Object.keys(value).length === 1 && Object.hasOwn(value, "node")
      ? decodeDataValue(value.node, decodePayload)
      : value;
  }
  switch (variant) {
    case "CommandNone":
      return { type: "cmd", kind: "none" };
    case "CommandMessage":
      return {
        type: "cmd",
        kind: "message",
        value: decodeEncodedPayload(value.payload, decodePayload),
      };
    case "CommandBatch":
      return {
        type: "cmd",
        kind: "batch",
        children: Array.isArray(value.children)
          ? value.children.map((child) => decodeDataValue(child, decodePayload))
          : [],
      };
    case "CommandMap":
      return {
        type: "cmd",
        kind: "map",
        child: decodeDataValue(value.child, decodePayload),
        handlerId: value.handler_id,
      };
    case "CommandRuntime":
      return {
        type: "cmd",
        kind: value.kind,
        ...(Object.hasOwn(value, "payload")
          ? { value: decodeEncodedPayload(value.payload, decodePayload) }
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
        value: decodeEncodedPayload(value.payload, decodePayload),
      };
    case "CommandOwned": {
      const child = decodeDataValue(value.child, decodePayload);
      return isRecord(child)
        ? {
            ...child,
            __vxOwnedMapHandlerIds: [value.handler_ref],
          }
        : child;
    }
    case "CommandCanvasRender":
      return {
        type: "cmd",
        kind: "canvas_render",
        value: decodeEncodedPayload(value.payload, decodePayload),
      };
    case "CommandCanvasMeasureText":
      return {
        type: "cmd",
        kind: "canvas_measure_text",
        selector: value.selector,
        value: value.value,
        font: value.font,
        handlerId: value.handler_ref,
      };
    case "SubscriptionNone":
      return { type: "sub", kind: "none" };
    case "SubscriptionBatch":
      return {
        type: "sub",
        kind: "batch",
        children: Array.isArray(value.children)
          ? value.children.map((child) => decodeDataValue(child, decodePayload))
          : [],
      };
    case "SubscriptionRuntime":
      return {
        type: "sub",
        kind: value.kind,
        key: value.key,
        ...(typeof value.event === "string" ? { event: value.event } : {}),
        ...(typeof value.query === "string" ? { query: value.query } : {}),
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(typeof value.millis === "bigint"
          ? { ms: Number(value.millis) }
          : typeof value.millis === "number"
            ? { ms: value.millis }
            : {}),
        ...(Object.hasOwn(value, "payload")
          ? { value: decodeEncodedPayload(value.payload, decodePayload) }
          : {}),
      };
    case "SubscriptionMap":
      return {
        type: "sub",
        kind: "map",
        child: decodeDataValue(value.child, decodePayload),
        handlerId: value.handler_ref,
        ...(typeof value.handler_key === "number"
          ? { handlerKey: value.handler_key }
          : {}),
      };
    case "SubscriptionOwned": {
      const child = decodeDataValue(value.child, decodePayload);
      return isRecord(child)
        ? { ...child, __vxOwnedMapHandlerIds: [value.handler_ref] }
        : child;
    }
    case "ProgramResult": {
      const frame = decodeOptionalWire(value.frame, decodePayload);
      const commands = decodeOptionalWire(value.commands, decodePayload);
      const subscriptions = decodeOptionalWire(value.subscriptions, decodePayload);
      return {
        $vx: "runtime_result",
        model: decodeEncodedPayload(value.model, decodePayload),
        ...(frame !== undefined ? { frame } : {}),
        ...(commands !== undefined ? { commands } : {}),
        ...(subscriptions !== undefined ? { subscriptions } : {}),
      };
    }
    case "ProgramMapModel": {
      const hydrateHandlerId = decodeOptionalWire(
        value.hydrate_handler_ref,
        decodePayload,
      );
      return {
        kind: "program_map_model",
        child: decodeDataValue(value.child, decodePayload),
        handlerId: value.handler_ref,
        ...(typeof hydrateHandlerId === "number" ? { hydrateHandlerId } : {}),
      };
    }
    case "ProgramMapMessage":
      return {
        kind: "program_map_message",
        child: decodeDataValue(value.child, decodePayload),
        handlerId: value.handler_ref,
      };
    case "ProgramHandlers": {
      const subscriptionsHandlerId = decodeOptionalWire(
        value.subscriptions_handler_ref,
        decodePayload,
      );
      return {
        kind: "program",
        initHandlerId: value.init_handler_ref,
        hydrateHandlerId: value.hydrate_handler_ref,
        stepHandlerId: value.step_handler_ref,
        viewHandlerId: value.view_handler_ref,
        ...(typeof subscriptionsHandlerId === "number"
          ? { subscriptionsHandlerId }
          : {}),
      };
    }
    case "AttrString":
    case "AttrBool":
    case "AttrI32":
      return value.value;
    case "NamedAttr":
      return {
        kind: value.kind,
        name: value.name,
        value: decodeDataValue(value.value, decodePayload),
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
        children: decodeWireList(
          value.children,
          "HtmlWireEnd",
          "HtmlWireNext",
          decodePayload,
        ),
      };
    case "HtmlElement":
      return decodeHtmlElement(value, decodePayload);
    case "HtmlKeyed": {
      const child = decodeDataValue(value.child, decodePayload);
      return isRecord(child) ? { ...child, key: value.key } : child;
    }
    case "HtmlMapped":
      return {
        kind: "map",
        child: decodeDataValue(value.child, decodePayload),
        handlerId: value.handler_ref,
      };
    case "HtmlFrame":
      return {
        version: value.version,
        root: decodeDataValue(value.root, decodePayload),
      };
    default:
      return value;
  }
};

const decodeHtmlElement = (
  value: Record<string, unknown>,
  decodePayload?: VxPayloadDecoder,
): unknown => {
  const attrs: Record<string, unknown> = {};
  const props: Record<string, unknown> = {};
  const styles: Record<string, unknown> = {};
  const events: unknown[] = [];
  const targetFor = (kind: unknown): Record<string, unknown> =>
    kind === "prop" ? props : kind === "style" ? styles : attrs;
  decodeWireList(
    value.attrs,
    "AttrWireEnd",
    "AttrWireNext",
    decodePayload,
  ).forEach(
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
    children: decodeWireList(
      value.children,
      "HtmlWireEnd",
      "HtmlWireNext",
      decodePayload,
    ),
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
  decodePayload?: VxPayloadDecoder,
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
    out.push(decodeDataValue(current.value, decodePayload));
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

const decodeEncodedPayload = (
  value: unknown,
  decodePayload?: VxPayloadDecoder,
): unknown => {
  if (!isRecord(value) || !(value.bytes instanceof Uint8Array)) {
    throw new Error("vx-dom: encoded payload is missing immutable bytes");
  }
  if (
    typeof value.fingerprint !== "string" ||
    value.fingerprint.length !== 64
  ) {
    throw new Error("vx-dom: encoded payload is missing its DTO fingerprint");
  }
  if (!decodePayload) {
    throw new Error("vx-dom: encoded payload requires the selected host transport");
  }
  return decodePayload(value.bytes, value.fingerprint);
};

const decodeOptionalWire = (
  value: unknown,
  decodePayload?: VxPayloadDecoder,
): unknown => {
  if (!isRecord(value)) return undefined;
  const tag =
    typeof value.$variant === "string"
      ? value.$variant
      : typeof value.tag === "string"
        ? value.tag
        : undefined;
  if (tag === "None") return undefined;
  return tag === "Some"
    ? decodeDataValue(value.value, decodePayload)
    : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
