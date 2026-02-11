import binaryen from "binaryen";

const MEMORY_SEED_WAT = `(module (memory 1))`;
let seededModuleBytes: Uint8Array | undefined;

const getSeededModuleBytes = (): Uint8Array => {
  if (seededModuleBytes) return seededModuleBytes;
  const seed = binaryen.parseText(MEMORY_SEED_WAT);
  seed.setFeatures(binaryen.Features.All);
  const bytes = seed.emitBinary();
  if (bytes.length === 0) {
    throw new Error("binaryen failed to emit seeded memory module");
  }
  seededModuleBytes = bytes;
  return bytes;
};

export const createCodegenModule = (): binaryen.Module =>
  binaryen.readBinary(getSeededModuleBytes());
