import binaryen from "binaryen";

const MEMORY_SEED_WAT = `(module (memory 1))`;
let seededModuleBytes: Uint8Array | undefined;

export const CODEGEN_BINARYEN_FEATURES =
  binaryen.Features.GC |
  binaryen.Features.ReferenceTypes |
  binaryen.Features.TailCall |
  binaryen.Features.Multivalue |
  binaryen.Features.BulkMemory |
  binaryen.Features.SignExt |
  binaryen.Features.MutableGlobals |
  binaryen.Features.ExtendedConst;

const getSeededModuleBytes = (): Uint8Array => {
  if (seededModuleBytes) return seededModuleBytes;
  const seed = binaryen.parseText(MEMORY_SEED_WAT);
  seed.setFeatures(CODEGEN_BINARYEN_FEATURES);
  const bytes = seed.emitBinary();
  if (bytes.length === 0) {
    throw new Error("binaryen failed to emit seeded memory module");
  }
  seededModuleBytes = bytes;
  return bytes;
};

export const createCodegenModule = (): binaryen.Module => {
  const mod = binaryen.readBinary(getSeededModuleBytes());
  mod.setFeatures(CODEGEN_BINARYEN_FEATURES);
  return mod;
};
