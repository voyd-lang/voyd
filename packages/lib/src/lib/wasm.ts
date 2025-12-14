import binaryen from "binaryen";

export const getWasmInstance = (
  mod: Uint8Array | binaryen.Module
): WebAssembly.Instance => {
  const bin = (
    mod instanceof Uint8Array ? mod : mod.emitBinary()
  ) as unknown as BufferSource;
  const compiled = new WebAssembly.Module(bin);
  const noop = () => 0;
  return new WebAssembly.Instance(compiled, {
    env: {
      __voyd_msgpack_write_value: noop,
      __voyd_msgpack_write_effect: noop,
      __voyd_msgpack_read_value: noop,
    },
  });
};

export const getWasmFn = (
  name: string,
  instance: WebAssembly.Instance
): Function | undefined => {
  const fn = instance.exports[name];
  return typeof fn === "function" ? fn : undefined;
};
