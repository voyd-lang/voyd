import { decode } from "@msgpack/msgpack";

const taskObserverProperty = Symbol.for("voyd.taskObserver");

export function decodeVxPayload(value: unknown): unknown {
  if (!(value instanceof Uint8Array)) return value;
  const decoded = decode(value);
  const observer = (value as unknown as Record<PropertyKey, unknown>)[
    taskObserverProperty
  ];
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
