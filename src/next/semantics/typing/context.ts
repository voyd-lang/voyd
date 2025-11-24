import { createTypeArena } from "./type-arena.js";
import { createTypeTable } from "./type-table.js";
import { DeclTable } from "../decls.js";
import {
  BASE_OBJECT_NAME,
  DEFAULT_EFFECT_ROW,
  type TypingState,
  type TypingContext,
  type TypingInputs,
} from "./types.js";

export const createTypingContext = (inputs: TypingInputs): TypingContext => {
  const decls = inputs.decls ?? new DeclTable();
  const arena = createTypeArena();
  const table = createTypeTable();

  return {
    symbolTable: inputs.symbolTable,
    hir: inputs.hir,
    overloads: inputs.overloads,
    decls,
    arena,
    table,
    resolvedExprTypes: new Map(),
    valueTypes: new Map(),
    callResolution: {
      targets: new Map(),
      typeArguments: new Map(),
      instanceKeys: new Map(),
    },
    functions: {
      signatures: new Map(),
      bySymbol: new Map(),
      instances: new Map(),
      instantiationInfo: new Map(),
      instanceExprTypes: new Map(),
      activeInstantiations: new Set(),
    },
    objects: {
      templates: new Map(),
      instances: new Map(),
      byName: new Map(),
      byNominal: new Map(),
      decls: new Map(),
      resolving: new Set(),
      base: {
        symbol: -1,
        nominal: -1,
        structural: -1,
        type: -1,
      },
    },
    typeAliases: {
      templates: new Map(),
      instances: new Map(),
      instanceSymbols: new Map(),
      validatedInstances: new Set(),
      byName: new Map(),
      resolving: new Map(),
      resolvingKeysById: new Map(),
      failedInstantiations: new Set(),
    },
    primitives: {
      cache: new Map(),
      bool: 0,
      void: 0,
      unknown: 0,
      defaultEffectRow: DEFAULT_EFFECT_ROW,
    },
    intrinsicTypes: new Map(),
  };
};

export const seedBaseObjectName = (ctx: TypingContext): void => {
  if (!ctx.objects.byName.has(BASE_OBJECT_NAME)) {
    ctx.objects.byName.set(BASE_OBJECT_NAME, ctx.objects.base.symbol);
  }
};

export const createTypingState = (mode: TypingState["mode"] = "relaxed"): TypingState => ({
  mode,
});
