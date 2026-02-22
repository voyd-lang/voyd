import {
  buildHandlerKey,
  parseEffectTable,
  resolveEffectOp,
  resolveSignatureHashForOp,
  toHostProtocolTable,
  type HostProtocolTable,
} from "@voyd/js-host";
import type { CompileArtifactsSuccess } from "./compile.js";
import { createHost, registerHandlers, registerHandlersByLabelSuffix } from "./host.js";
import { createTestCollection } from "./tests.js";
import type { CompileSuccessResult, RunOptions } from "./types.js";

const DEFAULT_EFFECT_TABLE_VERSION = 2;

const isMissingEffectTableError = (value: unknown): boolean =>
  value instanceof Error && /Missing effect table export/i.test(value.message);

const buildEffectsTable = (wasm: Uint8Array): HostProtocolTable => {
  try {
    return toHostProtocolTable(parseEffectTable(wasm));
  } catch (error) {
    if (isMissingEffectTableError(error)) {
      return { version: DEFAULT_EFFECT_TABLE_VERSION, ops: [] };
    }
    throw error;
  }
};

const findUniqueOpByLabelSuffix = ({
  table,
  labelSuffix,
}: {
  table: HostProtocolTable;
  labelSuffix: string;
}): HostProtocolTable["ops"][number] => {
  const matches = table.ops.filter((op) => op.label?.endsWith(labelSuffix));
  if (matches.length === 1) return matches[0]!;
  const labels = matches.map((op) => op.label ?? "<missing>").join(", ");
  throw new Error(
    `Expected exactly 1 op matching suffix ${labelSuffix}, found ${matches.length} (${labels})`
  );
};

const createEffectsInfo = ({
  table,
}: {
  table: HostProtocolTable;
}): CompileSuccessResult["effects"] => ({
  table,
  findUniqueOpByLabelSuffix: (labelSuffix) =>
    findUniqueOpByLabelSuffix({ table, labelSuffix }),
  signatureHashFor: ({ effectId, opName }) =>
    resolveSignatureHashForOp({ table, effectId, opName }),
  handlerKeyFor: ({ effectId, opName, signatureHash }) => {
    if (signatureHash) {
      return buildHandlerKey({
        effectId,
        opName,
        signatureHash: resolveSignatureHashForOp({
          table,
          effectId,
          opName,
          signatureHash,
        }),
      });
    }
    resolveEffectOp({ table, effectId, opName });
    return buildHandlerKey({ effectId, opName });
  },
});

const createRun = ({
  wasm,
}: {
  wasm: Uint8Array;
}): CompileSuccessResult["run"] => {
  return async <T = unknown>({
    entryName,
    handlers,
    handlersByLabelSuffix,
    imports,
    bufferSize,
    args,
  }: Omit<RunOptions, "wasm">): Promise<T> => {
    const host = await createHost({ wasm, imports, bufferSize });
    if (handlersByLabelSuffix) {
      registerHandlersByLabelSuffix({ host, handlersByLabelSuffix });
    }
    if (handlers) {
      registerHandlers({ host, handlers });
    }
    return host.run<T>(entryName, args);
  };
};

export const createCompileResult = async (
  artifacts: CompileArtifactsSuccess,
): Promise<CompileSuccessResult> => {
  const run = createRun({ wasm: artifacts.wasm });
  const effects = createEffectsInfo({
    table: buildEffectsTable(artifacts.wasm),
  });
  const testsWasm = artifacts.testsWasm ?? artifacts.wasm;
  const tests = artifacts.tests
    ? createTestCollection({
        cases: artifacts.tests,
        wasm: testsWasm,
      })
    : undefined;

  return {
    success: true,
    wasm: artifacts.wasm,
    wasmText: artifacts.wasmText,
    effects,
    run,
    tests,
  };
};
