import binaryen from "binaryen";

export const getWasmInstance = (
  mod: Uint8Array | binaryen.Module
): WebAssembly.Instance => {
  const bin = mod instanceof Uint8Array ? mod : mod.emitBinary();
  const compiled = new WebAssembly.Module(bin);
  return new WebAssembly.Instance(compiled);
};

export const getWasmFn = (
  name: string,
  instance: WebAssembly.Instance
): Function | undefined => {
  const fn = instance.exports[name];
  return typeof fn === "function" ? fn : undefined;
};
