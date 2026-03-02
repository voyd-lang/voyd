import binaryen from "binaryen";
import type {
  CodegenContext,
  CodegenOptions,
  CodegenResult,
  FunctionMetadata,
  ModuleLetGetterMetadata,
  FixedArrayWasmType,
  RuntimeTypeIdRegistryEntry,
  StructuralTypeInfo,
} from "./context.js";
import { createRttContext } from "./rtt/index.js";
import { createEffectRuntime } from "./effects/runtime-abi.js";
import {
  compileFunctions,
  emitModuleExports,
  prepareReachableFunctionSymbols,
  registerImportMetadata,
  registerFunctionMetadata,
} from "./functions.js";
import {
  preRegisterModuleLetGetters,
  registerModuleLetGetters,
} from "./module-lets.js";
import { buildRuntimeTypeArtifacts } from "./runtime-pass.js";
import {
  EFFECT_TABLE_EXPORT,
  emitEffectTableSection,
} from "./effects/effect-table.js";
import { emitRuntimeDiagnosticsSection } from "./exports/runtime-diagnostics.js";
import { buildEffectRegistry } from "./effects/effect-registry.js";
import type { OutcomeValueBox } from "./effects/outcome-values.js";
import {
  selectEffectsBackend,
  type EffectsBackend,
} from "./effects/codegen-backend.js";
import { createEffectsState } from "./effects/state.js";
import {
  buildProgramCodegenView,
  type ProgramCodegenView,
} from "../semantics/codegen-view/index.js";
import type { SemanticsPipelineResult } from "../semantics/pipeline.js";
import type {
  ProgramFunctionInstanceId,
  SymbolId,
  TypeId,
} from "../semantics/ids.js";
import { DiagnosticEmitter } from "../diagnostics/index.js";
import { createCodegenModule } from "./wasm-module.js";
import { createProgramHelperRegistry } from "./program-helpers.js";
import { applyConfiguredMemoryExports } from "./memory-exports.js";

const DEFAULT_OPTIONS: Required<CodegenOptions> = {
  optimize: false,
  validate: true,
  runtimeDiagnostics: true,
  emitEffectHelpers: false,
  effectsHostBoundary: "msgpack",
  linearMemoryExport: "always",
  effectsMemoryExport: "auto",
  continuationBackend: {},
  testMode: false,
  testScope: "all",
};

export type CodegenProgramParams = {
  program: ProgramCodegenView;
  entryModuleId: string;
  options?: CodegenOptions;
};

export type ContinuationBackendKind = "gc-trampoline" | "stack-switch";

export const codegen = (
  semantics: SemanticsPipelineResult,
  options: CodegenOptions = {},
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
  const mod = createCodegenModule();
  const mergedOptions: Required<CodegenOptions> = {
    ...DEFAULT_OPTIONS,
    ...options,
    continuationBackend: {
      ...DEFAULT_OPTIONS.continuationBackend,
      ...(options.continuationBackend ?? {}),
    },
  };
  const rtt = createRttContext(mod);
  const effectsRuntime = createEffectRuntime(mod);
  const functions = new Map<string, Map<number, FunctionMetadata[]>>();
  const functionInstances = new Map<
    ProgramFunctionInstanceId,
    FunctionMetadata
  >();
  const moduleLetGetters: Map<
    string,
    Map<SymbolId, ModuleLetGetterMetadata>
  > = new Map();
  const outcomeValueTypes = new Map<string, OutcomeValueBox>();
  const runtimeTypeRegistry = new Map<TypeId, RuntimeTypeIdRegistryEntry>();
  const runtimeTypeIdsByKey = new Map<string, number>();
  const runtimeTypeIdCounter = { value: 1 };
  const diagnostics = new DiagnosticEmitter();
  const programHelpers = createProgramHelperRegistry();
  const structTypes = new Map<string, StructuralTypeInfo>();
  const structHeapTypes = new Map<TypeId, binaryen.Type>();
  const structuralIdCache = new Map<TypeId, TypeId | null>();
  const resolvingStructuralIds = new Set<TypeId>();
  const fixedArrayTypes = new Map<TypeId, FixedArrayWasmType>();
  const contexts: CodegenContext[] = modules.map((sem) => ({
    mod,
    moduleId: sem.moduleId,
    moduleLabel: sanitizeIdentifier(sem.hir.module.path),
    program,
    module: sem,
    diagnostics,
    options: mergedOptions,
    programHelpers,
    functions,
    functionInstances,
    moduleLetGetters,
    itemsToSymbols: new Map(),
    structTypes,
    structHeapTypes,
    structuralIdCache,
    resolvingStructuralIds,
    fixedArrayTypes,
    closureTypes: new Map(),
    functionRefTypes: new Map(),
    recursiveBinders: new Map(),
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
      callArgTemps: new Map(),
      tempTypeIds: new Map(),
    },
    outcomeValueTypes,
  }));

  const siteCounter = { current: 0 };
  const entryCtx =
    contexts.find((ctx) => ctx.moduleId === entryModuleId) ?? contexts[0];
  prepareReachableFunctionSymbols({ contexts, entryModuleId });
  applyConfiguredMemoryExports(entryCtx);
  contexts.forEach((ctx) => {
    ctx.effectsBackend = selectEffectsBackend(ctx);
  });
  contexts.forEach((ctx) => {
    ctx.effectLowering = ctx.effectsBackend.buildLowering({ ctx, siteCounter });
  });
  contexts.forEach(registerFunctionMetadata);
  const effectRegistry = buildEffectRegistry(contexts);
  contexts.forEach((ctx) => {
    ctx.effectsState.effectRegistry = effectRegistry;
  });
  contexts.forEach(registerImportMetadata);
  buildRuntimeTypeArtifacts(contexts);
  preRegisterModuleLetGetters(contexts);
  contexts.forEach(registerModuleLetGetters);
  const compileReachableFunctions = (): void => {
    let compiled = 0;
    do {
      compiled = contexts.reduce(
        (count, ctx) =>
          count + compileFunctions({ ctx, contexts, entryModuleId }),
        0,
      );
    } while (compiled > 0);
  };
  compileReachableFunctions();

  emitModuleExports(entryCtx, contexts);
  compileReachableFunctions();
  const effectTable = emitEffectTableSection({
    contexts,
    entryModuleId,
    mod,
    exportName: EFFECT_TABLE_EXPORT,
  });
  if (mergedOptions.runtimeDiagnostics) {
    emitRuntimeDiagnosticsSection({
      contexts,
      mod,
    });
  }
  if (mergedOptions.emitEffectHelpers) {
    entryCtx.programHelpers.ensureEffectHelpers(entryCtx);
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

  return {
    module: mod,
    effectTable,
    diagnostics: [...diagnostics.diagnostics],
    continuationBackendKind: entryCtx.effectsBackend.kind,
  };
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
  const stackSwitchRequested = options.continuationBackend?.stackSwitching === true;
  if (!stackSwitchRequested) {
    return {
      preferredKind: "gc-trampoline",
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
  const preferredKind = preferred.continuationBackendKind;
  if (preferredKind !== "stack-switch") {
    return { preferredKind, preferred };
  }
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
    : ((emitted as { binary?: Uint8Array; output?: Uint8Array }).output ??
        (emitted as { binary?: Uint8Array }).binary ??
        new Uint8Array());
};
