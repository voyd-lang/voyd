import { decode } from "@msgpack/msgpack";
import type { CallOptions, VoydComponentFn } from "./types.js";

const taskObserverProperty = Symbol.for("voyd.taskObserver");

export function callComponentFn(
  componentFn: VoydComponentFn,
  options: CallOptions,
): unknown {
  const memory = resolveMemory(options);
  if (!memory) {
    throw new Error(
      "vx-dom: Unable to resolve WebAssembly memory. Pass { instance } or { memory }.",
    );
  }

  const length = componentFn();
  const view = memory.buffer.slice(0, length);
  return decode(view);
}

export function decodeVxWire(value: unknown): unknown {
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

export function resolveMemory(options: CallOptions): WebAssembly.Memory | undefined {
  if ("memory" in options && options.memory) return options.memory;
  if ("instance" in options && options.instance?.exports) {
    const exports = options.instance.exports as Record<string, unknown>;
    const mem = exports.main_memory ?? exports.memory;
    if (isMemory(mem)) return mem;
  }
  return undefined;
}

function isMemory(maybe: unknown): maybe is WebAssembly.Memory {
  return !!maybe && typeof maybe === "object" && "grow" in maybe;
}
