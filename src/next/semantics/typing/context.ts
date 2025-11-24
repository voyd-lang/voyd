import { createTypeArena } from "./type-arena.js";
import { createTypeTable } from "./type-table.js";
import { DeclTable } from "../decls.js";
import {
  BASE_OBJECT_NAME,
  DEFAULT_EFFECT_ROW,
  FunctionStore,
  ObjectStore,
  TypeAliasStore,
  type TypingState,
  type TypingContext,
  type TypingInputs,
} from "./types.js";

export const createTypingContext = (inputs: TypingInputs): TypingContext => {
  const decls = inputs.decls ?? new DeclTable();
  const arena = createTypeArena();
  const table = createTypeTable();
  const functions = new FunctionStore();
  const objects = new ObjectStore();
  const typeAliases = new TypeAliasStore();

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
    functions,
    objects,
    typeAliases,
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
  if (!ctx.objects.hasName(BASE_OBJECT_NAME)) {
    ctx.objects.setName(BASE_OBJECT_NAME, ctx.objects.base.symbol);
  }
};

export const createTypingState = (mode: TypingState["mode"] = "relaxed"): TypingState => ({
  mode,
});
