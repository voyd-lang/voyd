import type { CompileArtifacts } from "./compile.js";
import type { CompileResult, RunOptions } from "./types.js";
import { createHost, registerHandlers } from "./host.js";
import { createTestCollection } from "./tests.js";

const createRun = ({ wasm }: { wasm: Uint8Array }): CompileResult["run"] => {
  return async <T = unknown>({
    entryName,
    handlers,
    imports,
    bufferSize,
  }: Omit<RunOptions, "wasm">): Promise<T> => {
    const host = await createHost({ wasm, imports, bufferSize });
    if (handlers) {
      registerHandlers({ host, handlers });
    }
    return host.run<T>(entryName);
  };
};

export const createCompileResult = async (
  artifacts: CompileArtifacts
): Promise<CompileResult> => {
  const run = createRun({ wasm: artifacts.wasm });
  const testsWasm = artifacts.testsWasm ?? artifacts.wasm;
  const tests = artifacts.tests
    ? createTestCollection({
        cases: artifacts.tests,
        wasm: testsWasm,
      })
    : undefined;

  return {
    wasm: artifacts.wasm,
    wasmText: artifacts.wasmText,
    diagnostics: artifacts.diagnostics,
    run,
    tests,
  };
};
