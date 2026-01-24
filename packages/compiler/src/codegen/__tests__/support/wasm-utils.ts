export const wasmBufferSource = (wasm: Uint8Array | ArrayBuffer): ArrayBuffer => {
  if (wasm instanceof ArrayBuffer) {
    return wasm;
  }
  if (
    wasm.byteOffset === 0 &&
    wasm.buffer instanceof ArrayBuffer &&
    wasm.byteLength === wasm.buffer.byteLength
  ) {
    return wasm.buffer;
  }
  const copy = new Uint8Array(wasm.byteLength);
  copy.set(wasm);
  return copy.buffer;
};
