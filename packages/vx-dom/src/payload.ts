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
  if (variant === undefined) return value;
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
    default:
      return value;
  }
};

const decodeEncodedPayload = (value: unknown): unknown => {
  if (!isRecord(value) || !(value.bytes instanceof Uint8Array)) {
    throw new Error("vx-dom: encoded payload is missing immutable bytes");
  }
  if (typeof value.fingerprint !== "string" || value.fingerprint.length !== 64) {
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
