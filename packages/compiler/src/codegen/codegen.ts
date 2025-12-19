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
import { buildEffectsLoweringInfo } from "../semantics/effects/analysis.js";

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

export type ContinuationBackendKind = "gc-trampoline" | "stack-switch";

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
  const mergedOptions: Required<CodegenOptions> = {
    ...DEFAULT_OPTIONS,
    ...options,
    continuationBackend: {
      ...DEFAULT_OPTIONS.continuationBackend,
      ...(options.continuationBackend ?? {}),
    },
  };
  mod.setFeatures(binaryen.Features.All);
  const rtt = createRttContext(mod);
  const effectsRuntime = createEffectRuntime(mod);
  const functions = new Map<string, FunctionMetadata[]>();
  const functionInstances = new Map<string, FunctionMetadata>();
  const outcomeValueTypes = new Map<string, OutcomeValueBox>();
  const contexts: CodegenContext[] = modules.map((sem) => ({
    mod,
    moduleId: sem.moduleId,
    moduleLabel: sanitizeIdentifier(sem.hir.module.path),
    effectIdOffset: 0,
    binding: sem.binding,
    symbolTable: sem.symbolTable,
    hir: sem.hir,
    typing: sem.typing,
    effectsInfo: buildEffectsLoweringInfo({
      binding: sem.binding,
      symbolTable: sem.symbolTable,
      hir: sem.hir,
      typing: sem.typing,
    }),
    options: mergedOptions,
    functions,
    functionInstances,
    itemsToSymbols: new Map(),
    structTypes: new Map(),
    fixedArrayTypes: new Map(),
    closureTypes: new Map(),
    functionRefTypes: new Map(),
    lambdaEnvs: new Map(),
    lambdaFunctions: new Map(),
    rtt,
    effectsRuntime,
    effectsBackend: undefined as unknown as EffectsBackend,
    effectsState: createEffectsState(),
    effectLowering: {
      sitesByExpr: new Map(),
      sites: [],
      argsTypes: new Map(),
      callArgTemps: new Map(),
      tempTypeIds: new Map(),
    },
    outcomeValueTypes,
  }));

  let effectIdOffset = 0;
  contexts.forEach((ctx) => {
    ctx.effectIdOffset = effectIdOffset;
    effectIdOffset += ctx.binding.effects.length;
  });

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
  emitModuleExports(entryCtx, contexts);
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

export const codegenProgramWithContinuationFallback = ({
  modules,
  entryModuleId,
  options = {},
}: CodegenProgramParams): {
  preferredKind: ContinuationBackendKind;
  preferred: CodegenResult;
  fallback?: CodegenResult;
} => {
  const preferredKind: ContinuationBackendKind =
    options.continuationBackend?.stackSwitching === true
      ? "stack-switch"
      : "gc-trampoline";

  if (preferredKind !== "stack-switch") {
    return {
      preferredKind,
      preferred: codegenProgram({ modules, entryModuleId, options }),
    };
  }

  const preferred = codegenProgram({
    modules,
    entryModuleId,
    options: {
      ...options,
      continuationBackend: { ...(options.continuationBackend ?? {}), stackSwitching: true },
    },
  });
  const fallback = codegenProgram({
    modules,
    entryModuleId,
    options: {
      ...options,
      continuationBackend: { ...(options.continuationBackend ?? {}), stackSwitching: false },
    },
  });
  return { preferredKind, preferred, fallback };
};

export type { CodegenOptions, CodegenResult } from "./context.js";

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
