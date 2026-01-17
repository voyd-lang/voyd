import binaryen from "binaryen";

const MULTI_MEMORY_WAT = `(module (memory 1) (memory 1))`;
let multiMemoryBytes: Uint8Array | undefined;

const getMultiMemoryBytes = (): Uint8Array => {
  if (multiMemoryBytes) return multiMemoryBytes;
  const seed = binaryen.parseText(MULTI_MEMORY_WAT);
  seed.setFeatures(binaryen.Features.All);
  const bytes = seed.emitBinary();
  if (bytes.length === 0) {
    throw new Error("binaryen failed to emit multi-memory seed module");
  }
  multiMemoryBytes = bytes;
  return bytes;
};

export const createMultiMemoryModule = (): binaryen.Module => {
  // Binaryen's JS API only supports a single defined memory via setMemory.
  // Seed a module with two defined memories via readBinary instead.
  return binaryen.readBinary(getMultiMemoryBytes());
};
