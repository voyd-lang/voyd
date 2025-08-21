import { encode, decode } from "@msgpack/msgpack";

/**
 * Write a JavaScript value to linear memory encoded with MessagePack.
 *
 * @param value The value to encode.
 * @param instance The WebAssembly instance whose memory will receive the data.
 * @param ptr The offset in linear memory to write to. Defaults to 0.
 * @returns The number of bytes written.
 */
export const writeJson = (
  value: unknown,
  instance: WebAssembly.Instance,
  ptr = 0
): number => {
  const memory = instance.exports.memory as WebAssembly.Memory;
  const bytes = encode(value);
  const buf = new Uint8Array(memory.buffer);

  const required = ptr + bytes.length;
  if (required > buf.length) {
    const pageSize = 64 * 1024;
    const currentPages = buf.length / pageSize;
    const neededPages = Math.ceil(required / pageSize);
    memory.grow(neededPages - currentPages);
  }

  new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
};

/**
 * Read a MessagePack encoded value from linear memory.
 *
 * @param ptr The offset in linear memory where the data lives.
 * @param length The number of bytes to read.
 * @param instance The WebAssembly instance whose memory holds the data.
 * @returns The decoded JavaScript value.
 */
export const readJson = <T = unknown>(
  ptr: number,
  length: number,
  instance: WebAssembly.Instance
): T => {
  const memory = instance.exports.memory as WebAssembly.Memory;
  const bytes = new Uint8Array(memory.buffer, ptr, length);
  return decode(bytes) as T;
};
