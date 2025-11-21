import { createTypeArena } from "./type-arena.js";
import { createTypeTable } from "./type-table.js";
import { DeclTable } from "../decls.js";
import {
  BASE_OBJECT_NAME,
  DEFAULT_EFFECT_ROW,
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
    functionSignatures: new Map(),
    valueTypes: new Map(),
    callTargets: new Map(),
    primitiveCache: new Map(),
    intrinsicTypes: new Map(),
    objectTemplates: new Map(),
    objectInstances: new Map(),
    objectsByName: new Map(),
    objectsByNominal: new Map(),
    objectDecls: new Map(),
    resolvingTemplates: new Set(),
    boolType: 0,
    voidType: 0,
    unknownType: 0,
    defaultEffectRow: DEFAULT_EFFECT_ROW,
    typeCheckMode: "relaxed",
    currentFunctionReturnType: undefined,
    typeAliasTargets: new Map(),
    typeAliasTemplates: new Map(),
    typeAliasInstances: new Map(),
    typeAliasesByName: new Map(),
    resolvingTypeAliases: new Set(),
    failedTypeAliasInstantiations: new Set(),
    baseObjectSymbol: -1,
    baseObjectNominal: -1,
    baseObjectStructural: -1,
    baseObjectType: -1,
  };
};

export const seedBaseObjectName = (ctx: TypingContext): void => {
  if (!ctx.objectsByName.has(BASE_OBJECT_NAME)) {
    ctx.objectsByName.set(BASE_OBJECT_NAME, ctx.baseObjectSymbol);
  }
};
