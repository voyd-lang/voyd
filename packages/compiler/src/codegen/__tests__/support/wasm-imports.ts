type WasmImportsOptions = {
  includeMsgPack?: boolean;
};

export const createEffectsImports = (
  options: WasmImportsOptions = {}
): WebAssembly.Imports => {
  if (!options.includeMsgPack) {
    return { env: {} };
  }

  const noop = () => 0;
  const noopI64 = () => 0n;
  return {
    env: {
      __voyd_msgpack_write_value: noop,
      __voyd_msgpack_write_effect: noop,
      __voyd_msgpack_read_value: noopI64,
    },
  };
};
