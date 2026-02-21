export const createEffectsImports = (): WebAssembly.Imports => ({
  env: {},
  voyd_math: {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    ln: Math.log,
    log2: Math.log2,
    log10: Math.log10,
    exp: Math.exp,
    pow: Math.pow,
    atan2: Math.atan2,
  },
});
