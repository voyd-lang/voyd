import binaryen from "binaryen";

const createVoydMathImports = (): Record<string, CallableFunction> => ({
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  exp: Math.exp,
  pow: Math.pow,
  atan2: Math.atan2,
});

const defaultImports = (): WebAssembly.Imports => ({
  env: {},
  voyd_math: createVoydMathImports(),
});

const toBinary = (mod: Uint8Array | binaryen.Module): BufferSource =>
  (mod instanceof Uint8Array ? mod : mod.emitBinary()) as unknown as BufferSource;

export const getWasmInstance = (
  mod: Uint8Array | binaryen.Module
): WebAssembly.Instance => {
  const compiled = new WebAssembly.Module(toBinary(mod));
  return new WebAssembly.Instance(compiled, defaultImports());
};

export const getWasmInstanceWithFallback = (params: {
  preferred: Uint8Array | binaryen.Module;
  fallback: Uint8Array | binaryen.Module;
}): { instance: WebAssembly.Instance; used: "preferred" | "fallback" } => {
  try {
    return { instance: getWasmInstance(params.preferred), used: "preferred" };
  } catch {
    return { instance: getWasmInstance(params.fallback), used: "fallback" };
  }
};

export const instantiateWasmWithFallback = async (params: {
  preferred: Uint8Array | binaryen.Module;
  fallback: Uint8Array | binaryen.Module;
}): Promise<{ instance: WebAssembly.Instance; used: "preferred" | "fallback" }> => {
  const preferred = toBinary(params.preferred);
  try {
    const result = await WebAssembly.instantiate(preferred, defaultImports());
    const instance = "instance" in result ? result.instance : result;
    return { instance, used: "preferred" };
  } catch {
    const result = await WebAssembly.instantiate(toBinary(params.fallback), defaultImports());
    const instance = "instance" in result ? result.instance : result;
    return { instance, used: "fallback" };
  }
};

export const getWasmFn = (
  name: string,
  instance: WebAssembly.Instance
): Function | undefined => {
  const fn = instance.exports[name];
  return typeof fn === "function" ? fn : undefined;
};
