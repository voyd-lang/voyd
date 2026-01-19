import type { CompileArtifacts } from "./compile.js";
import type { CompileResult, RunOptions, VoydHost } from "./types.js";
import { createHost, registerHandlers } from "./host.js";
import { createTestCollection } from "./tests.js";

type ResolveRunHostOptions = {
  wasm: Uint8Array;
  baseHost: VoydHost;
  imports?: WebAssembly.Imports;
  bufferSize?: number;
};

const resolveRunHost = async ({
  wasm,
  baseHost,
  imports,
  bufferSize,
}: ResolveRunHostOptions): Promise<VoydHost> => {
  if (!imports && typeof bufferSize !== "number") {
    return baseHost;
  }

  return createHost({ wasm, imports, bufferSize });
};

const createRun = ({
  wasm,
  host,
}: {
  wasm: Uint8Array;
  host: VoydHost;
}): CompileResult["run"] => {
  return async <T = unknown>({
    entryName,
    handlers,
    imports,
    bufferSize,
  }: Omit<RunOptions, "wasm">): Promise<T> => {
    const targetHost = await resolveRunHost({
      wasm,
      baseHost: host,
      imports,
      bufferSize,
    });
    if (handlers) {
      registerHandlers({ host: targetHost, handlers });
    }
    return targetHost.run<T>(entryName);
  };
};

export const createCompileResult = async (
  artifacts: CompileArtifacts
): Promise<CompileResult> => {
  const host = await createHost({ wasm: artifacts.wasm });
  const run = createRun({ wasm: artifacts.wasm, host });
  const tests = artifacts.tests
    ? createTestCollection({
        cases: artifacts.tests,
        wasm: artifacts.testsWasm ?? artifacts.wasm,
        host,
      })
    : undefined;

  return {
    wasm: artifacts.wasm,
    wasmText: artifacts.wasmText,
    diagnostics: artifacts.diagnostics,
    host,
    run,
    tests,
  };
};
