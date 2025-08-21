import binaryen from "binaryen";

export const getWasmInstance = (
  mod: Uint8Array | binaryen.Module,
  imports?: WebAssembly.Imports
): WebAssembly.Instance => {
  const bin = (
    mod instanceof Uint8Array ? mod : mod.emitBinary()
  ) as unknown as BufferSource;
  const compiled = new WebAssembly.Module(bin);
  return new WebAssembly.Instance(compiled, imports);
};

export const getWasmFn = (
  name: string,
  instance: WebAssembly.Instance
): Function | undefined => {
  const fn = instance.exports[name];
  return typeof fn === "function" ? fn : undefined;
};
