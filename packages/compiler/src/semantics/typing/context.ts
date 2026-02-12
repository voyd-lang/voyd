import { createTypeArena } from "./type-arena.js";
import { createTypeTable } from "./type-table.js";
import { DeclTable } from "../decls.js";
import { createEffectTable } from "../effects/effect-table.js";
import {
  BASE_OBJECT_NAME,
  FunctionStore,
  ObjectStore,
  TypeAliasStore,
  TraitStore,
  type TypeCheckBudgetConfig,
  type TypeCheckBudgetState,
  type TypingState,
  type TypingContext,
  type TypingInputs,
} from "./types.js";
import { DiagnosticEmitter } from "../../diagnostics/index.js";
import { createImportMaps } from "./import-maps.js";

export const DEFAULT_MAX_UNIFY_STEPS = 50_000;
export const DEFAULT_MAX_OVERLOAD_CANDIDATES = 64;

const normalizeBudgetLimit = ({
  value,
  fallback,
}: {
  value: number | undefined;
  fallback: number;
}): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.trunc(value));
};

export const createTypeCheckBudgetState = (
  config?: TypeCheckBudgetConfig,
): TypeCheckBudgetState => ({
  maxUnifySteps: normalizeBudgetLimit({
    value: config?.maxUnifySteps,
    fallback: DEFAULT_MAX_UNIFY_STEPS,
  }),
  maxOverloadCandidates: normalizeBudgetLimit({
    value: config?.maxOverloadCandidates,
    fallback: DEFAULT_MAX_OVERLOAD_CANDIDATES,
  }),
  unifyStepsUsed: { value: 0 },
});

export const createTypingContext = (inputs: TypingInputs): TypingContext => {
  const decls = inputs.decls ?? new DeclTable();
  const arena = inputs.arena ?? createTypeArena();
  const table = createTypeTable();
  const effects = inputs.effects ?? createEffectTable();
  const functions = new FunctionStore();
  const objects = new ObjectStore();
  const traits = new TraitStore();
  const typeAliases = new TypeAliasStore();
  const moduleExports = inputs.moduleExports ?? new Map();
  const dependencies = inputs.availableSemantics ?? new Map();
  const { importsByLocal, importAliasesByModule } = createImportMaps(
    inputs.imports,
  );
  const typeCheckBudget = createTypeCheckBudgetState(inputs.typeCheckBudget);

  return {
    symbolTable: inputs.symbolTable,
    hir: inputs.hir,
    overloads: inputs.overloads,
    typeCheckBudget,
    decls,
    moduleId: inputs.moduleId ?? "local",
    packageId: inputs.packageId ?? "local",
    moduleExports,
    dependencies,
    importsByLocal,
    importAliasesByModule,
    arena,
    table,
    effects,
    resolvedExprTypes: new Map(),
    valueTypes: new Map(),
    activeValueTypeComputations: new Set(),
    tailResumptions: new Map(),
    callResolution: {
      targets: new Map(),
      typeArguments: new Map(),
      instanceKeys: new Map(),
      traitDispatches: new Set(),
    },
    functions,
    objects,
    traits,
    typeAliases,
    primitives: {
      cache: new Map(),
      bool: 0,
      void: 0,
      unknown: 0,
      defaultEffectRow: effects.emptyRow,
      i32: 0,
      i64: 0,
      f32: 0,
      f64: 0,
    },
    intrinsicTypes: new Map(),
    diagnostics: new DiagnosticEmitter(),
    memberMetadata: new Map(),
    traitImplsByNominal: new Map(),
    traitImplsByTrait: new Map(),
    traitMethodImpls: new Map(),
  };
};

export const seedBaseObjectName = (ctx: TypingContext): void => {
  if (!ctx.objects.hasName(BASE_OBJECT_NAME)) {
    ctx.objects.setName(BASE_OBJECT_NAME, ctx.objects.base.symbol);
  }
};

export const createTypingState = (mode: TypingState["mode"] = "relaxed"): TypingState => ({
  mode,
});
