const WASM_PAGE_SIZE = 64 * 1024;

export const ensureMemoryCapacity = ({
  memory,
  requiredBytes,
  label,
}: {
  memory: WebAssembly.Memory;
  requiredBytes: number;
  label: string;
}): void => {
  const requiredPages = Math.ceil(requiredBytes / WASM_PAGE_SIZE);
  const currentPages = memory.buffer.byteLength / WASM_PAGE_SIZE;
  if (requiredPages <= currentPages) {
    return;
  }
  try {
    memory.grow(requiredPages - currentPages);
  } catch (error) {
    throw new Error(`${label} memory grow failed`, { cause: error });
  }
};
