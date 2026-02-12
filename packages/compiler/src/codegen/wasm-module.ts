import binaryen from "binaryen";
import { VOYD_BINARYEN_FEATURES } from "@voyd/lib/binaryen-features.js";

const MEMORY_SEED_WAT = `(module (memory 1))`;
let seededModuleBytes: Uint8Array | undefined;

const getSeededModuleBytes = (): Uint8Array => {
  if (seededModuleBytes) return seededModuleBytes;
  const seed = binaryen.parseText(MEMORY_SEED_WAT);
  seed.setFeatures(VOYD_BINARYEN_FEATURES);
  const bytes = seed.emitBinary();
  if (bytes.length === 0) {
    throw new Error("binaryen failed to emit seeded memory module");
  }
  seededModuleBytes = bytes;
  return bytes;
};

export const createCodegenModule = (): binaryen.Module => {
  const mod = binaryen.readBinary(getSeededModuleBytes());
  mod.setFeatures(VOYD_BINARYEN_FEATURES);
  return mod;
};
