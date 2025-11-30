import { createTypeArena } from "./type-arena.js";
import { createTypeTable } from "./type-table.js";
import { DeclTable } from "../decls.js";
import {
  BASE_OBJECT_NAME,
  DEFAULT_EFFECT_ROW,
  FunctionStore,
  ObjectStore,
  TypeAliasStore,
  TraitStore,
  type TypingState,
  type TypingContext,
  type TypingInputs,
} from "./types.js";
import { DiagnosticEmitter } from "../../diagnostics/index.js";

export const createTypingContext = (inputs: TypingInputs): TypingContext => {
  const decls = inputs.decls ?? new DeclTable();
  const arena = createTypeArena();
  const table = createTypeTable();
  const functions = new FunctionStore();
  const objects = new ObjectStore();
  const traits = new TraitStore();
  const typeAliases = new TypeAliasStore();
  const moduleExports = inputs.moduleExports ?? new Map();
  const dependencies = inputs.availableSemantics ?? new Map();
  const importsByLocal = new Map<
    number,
    { moduleId: string; symbol: number }
  >();
  const importAliasesByModule = new Map<string, Map<number, number>>();
  (inputs.imports ?? []).forEach((entry) => {
    if (!entry.target) {
      return;
    }
    importsByLocal.set(entry.local, entry.target);
    const bucket = importAliasesByModule.get(entry.target.moduleId) ?? new Map();
    bucket.set(entry.target.symbol, entry.local);
    importAliasesByModule.set(entry.target.moduleId, bucket);
  });

  return {
    symbolTable: inputs.symbolTable,
    hir: inputs.hir,
    overloads: inputs.overloads,
    decls,
    moduleId: inputs.moduleId,
    moduleExports,
    dependencies,
    importsByLocal,
    importAliasesByModule,
    arena,
    table,
    resolvedExprTypes: new Map(),
    valueTypes: new Map(),
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
      defaultEffectRow: DEFAULT_EFFECT_ROW,
    },
    intrinsicTypes: new Map(),
    diagnostics: new DiagnosticEmitter(),
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
