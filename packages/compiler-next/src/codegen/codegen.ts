import binaryen from "binaryen";
import type {
  CodegenContext,
  CodegenOptions,
  CodegenResult,
  FunctionMetadata,
  SemanticsPipelineResult,
} from "./context.js";
import { createRttContext } from "./rtt/index.js";
import { createEffectRuntime } from "./effects/runtime-abi.js";
import {
  compileFunctions,
  emitModuleExports,
  registerImportMetadata,
  registerFunctionMetadata,
} from "./functions.js";
import { buildEffectMir } from "./effects/effect-mir.js";
import {
  EFFECT_TABLE_EXPORT,
  emitEffectTableSection,
} from "./effects/effect-table.js";
import { addEffectRuntimeHelpers } from "./effects/runtime-helpers.js";
import type { OutcomeValueBox } from "./effects/outcome-values.js";
import {
  selectEffectsBackend,
  type EffectsBackend,
} from "./effects/codegen-backend.js";
import { createEffectsState } from "./effects/state.js";

const DEFAULT_OPTIONS: Required<CodegenOptions> = {
  optimize: false,
  validate: true,
  emitEffectHelpers: false,
  continuationBackend: {},
};

export type CodegenProgramParams = {
  modules: readonly SemanticsPipelineResult[];
  entryModuleId: string;
  options?: CodegenOptions;
};

export const codegen = (
  semantics: SemanticsPipelineResult,
  options: CodegenOptions = {}
): CodegenResult =>
  codegenProgram({
    modules: [semantics],
    entryModuleId: semantics.moduleId,
    options,
  });

export const codegenProgram = ({
  modules,
  entryModuleId,
  options = {},
}: CodegenProgramParams): CodegenResult => {
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  const rtt = createRttContext(mod);
  const effectsRuntime = createEffectRuntime(mod);
  const mergedOptions: Required<CodegenOptions> = {
    ...DEFAULT_OPTIONS,
    ...options,
    continuationBackend: {
      ...DEFAULT_OPTIONS.continuationBackend,
      ...(options.continuationBackend ?? {}),
    },
  };
  const functions = new Map<string, FunctionMetadata[]>();
  const functionInstances = new Map<string, FunctionMetadata>();
  const outcomeValueTypes = new Map<string, OutcomeValueBox>();
  const contexts: CodegenContext[] = modules.map((sem) => ({
    mod,
    moduleId: sem.moduleId,
    moduleLabel: sanitizeIdentifier(sem.hir.module.path),
    binding: sem.binding,
    symbolTable: sem.symbolTable,
    hir: sem.hir,
    typing: sem.typing,
    options: mergedOptions,
    functions,
    functionInstances,
    itemsToSymbols: new Map(),
    structTypes: new Map(),
    fixedArrayTypes: new Map(),
    closureTypes: new Map(),
    closureFunctionTypes: new Map(),
    lambdaEnvs: new Map(),
    lambdaFunctions: new Map(),
    rtt,
    effectsRuntime,
    effectMir: buildEffectMir({
      semantics: sem,
      options: mergedOptions.continuationBackend,
    }),
    effectsBackend: undefined as unknown as EffectsBackend,
    effectsState: createEffectsState(),
    effectLowering: { sitesByExpr: new Map(), sites: [], argsTypes: new Map() },
    outcomeValueTypes,
  }));

  const siteCounter = { current: 0 };
  contexts.forEach((ctx) => {
    ctx.effectsBackend = selectEffectsBackend(ctx);
  });
  contexts.forEach((ctx) => {
    ctx.effectLowering = ctx.effectsBackend.buildLowering({ ctx, siteCounter });
  });
  contexts.forEach(registerFunctionMetadata);
  contexts.forEach(registerImportMetadata);
  contexts.forEach(compileFunctions);

  const entryCtx =
    contexts.find((ctx) => ctx.moduleId === entryModuleId) ?? contexts[0];
  emitModuleExports(entryCtx);
  const effectTable = emitEffectTableSection({
    contexts,
    entryModuleId,
    mod,
    exportName: EFFECT_TABLE_EXPORT,
  });
  if (mergedOptions.emitEffectHelpers) {
    addEffectRuntimeHelpers(entryCtx);
  }

  if (mergedOptions.optimize) {
    mod.optimize();
  }

  if (mergedOptions.validate) {
    mod.validate();
  }

  return { module: mod, effectTable };
};

export type { CodegenOptions, CodegenResult } from "./context.js";

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
