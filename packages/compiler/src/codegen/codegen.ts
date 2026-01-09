import binaryen from "binaryen";
import type {
  CodegenContext,
  CodegenOptions,
  CodegenResult,
  FunctionMetadata,
  RuntimeTypeIdRegistryEntry,
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
import {
  buildProgramCodegenView,
  type ProgramCodegenView,
  type InstanceKey,
} from "../semantics/codegen-view/index.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type { TypeId } from "../semantics/ids.js";

const DEFAULT_OPTIONS: Required<CodegenOptions> = {
  optimize: false,
  validate: true,
  emitEffectHelpers: false,
  continuationBackend: {},
};

export type CodegenProgramParams = {
  program: ProgramCodegenView;
  entryModuleId: string;
  options?: CodegenOptions;
};

export type ContinuationBackendKind = "gc-trampoline" | "stack-switch";

export const codegen = (
  semantics: SemanticsPipelineResult,
  options: CodegenOptions = {}
): CodegenResult =>
  codegenProgram({
    program: buildProgramCodegenView([semantics]),
    entryModuleId: semantics.moduleId,
    options,
  });

export const codegenProgram = ({
  program,
  entryModuleId,
  options = {},
}: CodegenProgramParams): CodegenResult => {
  const modules = Array.from(program.modules.values());
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
  const functions = new Map<string, Map<number, FunctionMetadata[]>>();
  const functionInstances = new Map<InstanceKey, FunctionMetadata>();
  const outcomeValueTypes = new Map<string, OutcomeValueBox>();
  const runtimeTypeRegistry = new Map<TypeId, RuntimeTypeIdRegistryEntry>();
  const runtimeTypeIdsByKey = new Map<string, number>();
  const runtimeTypeIdCounter = { value: 1 };
  const contexts: CodegenContext[] = modules.map((sem) => ({
    mod,
    moduleId: sem.moduleId,
    moduleLabel: sanitizeIdentifier(sem.hir.module.path),
    effectIdOffset: 0,
    program,
    module: sem,
    options: mergedOptions,
    functions,
    functionInstances,
    itemsToSymbols: new Map(),
    structTypes: new Map(),
    fixedArrayTypes: new Map(),
    closureTypes: new Map(),
    functionRefTypes: new Map(),
    runtimeTypeRegistry,
    runtimeTypeIds: {
      byKey: runtimeTypeIdsByKey,
      nextId: runtimeTypeIdCounter,
    },
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
    effectIdOffset += ctx.module.binding.effects.length;
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
    const wasm = emitWasmBytes(mod);
    if (!WebAssembly.validate(wasm as BufferSource)) {
      mod.validate();
    }
  }

  return { module: mod, effectTable };
};

export const codegenProgramWithContinuationFallback = ({
  program,
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
      preferred: codegenProgram({ program, entryModuleId, options }),
    };
  }

  const preferred = codegenProgram({
    program,
    entryModuleId,
    options: {
      ...options,
      continuationBackend: {
        ...(options.continuationBackend ?? {}),
        stackSwitching: true,
      },
    },
  });
  const fallback = codegenProgram({
    program,
    entryModuleId,
    options: {
      ...options,
      continuationBackend: {
        ...(options.continuationBackend ?? {}),
        stackSwitching: false,
      },
    },
  });
  return { preferredKind, preferred, fallback };
};

export type { CodegenOptions, CodegenResult } from "./context.js";

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const emitWasmBytes = (mod: binaryen.Module): Uint8Array => {
  const emitted = mod.emitBinary();
  return emitted instanceof Uint8Array
    ? emitted
    : (emitted as { binary?: Uint8Array; output?: Uint8Array }).output ??
        (emitted as { binary?: Uint8Array }).binary ??
        new Uint8Array();
};
