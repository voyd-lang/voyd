import type binaryen from "binaryen";

export const emitWasmBytes = (mod: binaryen.Module): Uint8Array => {
  const emitted = mod.emitBinary();
  return emitted instanceof Uint8Array
    ? emitted
    : (emitted as { binary?: Uint8Array; output?: Uint8Array }).output ??
        (emitted as { binary?: Uint8Array }).binary ??
        new Uint8Array();
};

export const assertRunnableWasm = (mod: binaryen.Module): Uint8Array => {
  const wasm = emitWasmBytes(mod);
  if (WebAssembly.validate(wasm as BufferSource)) {
    return wasm;
  }

  mod.validate();
  throw new Error("Module is invalid");
};
