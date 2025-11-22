import type { SymbolTable } from "../binder/index.js";
import type {
  HirExpression,
  HirFunction,
  HirGraph,
  HirObjectDecl,
  HirTypeExpr,
} from "../hir/index.js";
import type {
  EffectRowId,
  HirExprId,
  OverloadSetId,
  SymbolId,
  TypeId,
  TypeParamId,
  TypeSchemeId,
} from "../ids.js";
import { DeclTable } from "../decls.js";
import type { TypeArena } from "./type-arena.js";
import type { TypeTable } from "./type-table.js";

export interface TypingInputs {
  symbolTable: SymbolTable;
  hir: HirGraph;
  overloads: ReadonlyMap<OverloadSetId, readonly SymbolId[]>;
  decls?: DeclTable;
}

export interface TypingResult {
  arena: TypeArena;
  table: TypeTable;
  resolvedExprTypes: ReadonlyMap<HirExprId, TypeId>;
  valueTypes: ReadonlyMap<SymbolId, TypeId>;
  objectsByNominal: ReadonlyMap<TypeId, ObjectTypeInfo>;
  callTargets: ReadonlyMap<HirExprId, ReadonlyMap<string, SymbolId>>;
  functionInstances: ReadonlyMap<string, TypeId>;
  callTypeArguments: ReadonlyMap<HirExprId, readonly TypeId[]>;
  callInstanceKeys: ReadonlyMap<HirExprId, string>;
  functionInstantiationInfo: ReadonlyMap<
    SymbolId,
    ReadonlyMap<string, readonly TypeId[]>
  >;
  functionInstanceExprTypes: ReadonlyMap<string, ReadonlyMap<HirExprId, TypeId>>;
}

export interface FunctionSignature {
  typeId: TypeId;
  parameters: readonly ParamSignature[];
  returnType: TypeId;
  hasExplicitReturn: boolean;
  typeParams?: readonly FunctionTypeParam[];
  scheme: TypeSchemeId;
  typeParamMap?: ReadonlyMap<SymbolId, TypeId>;
}

export interface ParamSignature {
  type: TypeId;
  label?: string;
}

export interface FunctionTypeParam {
  symbol: SymbolId;
  typeParam: TypeParamId;
  constraint?: TypeId;
  typeRef: TypeId;
}

export interface Arg {
  type: TypeId;
  label?: string;
}

export type TypeCheckMode = "relaxed" | "strict";

export interface TypingContext {
  symbolTable: SymbolTable;
  hir: HirGraph;
  overloads: ReadonlyMap<OverloadSetId, readonly SymbolId[]>;
  decls: DeclTable;
  arena: TypeArena;
  table: TypeTable;
  resolvedExprTypes: Map<HirExprId, TypeId>;
  functionSignatures: Map<SymbolId, FunctionSignature>;
  valueTypes: Map<SymbolId, TypeId>;
  callTargets: Map<HirExprId, Map<string, SymbolId>>;
  callTypeArguments: Map<HirExprId, readonly TypeId[]>;
  callInstanceKeys: Map<HirExprId, string>;
  functionInstantiationInfo: Map<SymbolId, Map<string, readonly TypeId[]>>;
  functionInstanceExprTypes: Map<string, Map<HirExprId, TypeId>>;
  primitiveCache: Map<string, TypeId>;
  intrinsicTypes: Map<string, TypeId>;
  objectTemplates: Map<SymbolId, ObjectTemplate>;
  objectInstances: Map<string, ObjectTypeInfo>;
  objectsByName: Map<string, SymbolId>;
  objectsByNominal: Map<TypeId, ObjectTypeInfo>;
  objectDecls: Map<SymbolId, HirObjectDecl>;
  resolvingTemplates: Set<SymbolId>;
  boolType: TypeId;
  voidType: TypeId;
  unknownType: TypeId;
  defaultEffectRow: EffectRowId;
  typeCheckMode: TypeCheckMode;
  currentFunctionReturnType: TypeId | undefined;
  currentFunctionInstanceKey?: string;
  currentTypeParams?: ReadonlyMap<SymbolId, TypeId>;
  currentTypeSubst?: ReadonlyMap<TypeParamId, TypeId>;
  typeAliasTargets: Map<SymbolId, HirTypeExpr>;
  typeAliasTemplates: Map<SymbolId, TypeAliasTemplate>;
  typeAliasInstances: Map<string, TypeId>;
  typeAliasesByName: Map<string, SymbolId>;
  resolvingTypeAliases: Set<string>;
  failedTypeAliasInstantiations: Set<string>;
  baseObjectSymbol: SymbolId;
  baseObjectNominal: TypeId;
  baseObjectStructural: TypeId;
  baseObjectType: TypeId;
  functionsBySymbol: Map<SymbolId, HirFunction>;
  functionInstances: Map<string, TypeId>;
  activeFunctionInstantiations: Set<string>;
}

export interface ObjectTypeInfo {
  nominal: TypeId;
  structural: TypeId;
  type: TypeId;
  fields: readonly {
    name: string;
    type: TypeId;
    declaringParams?: readonly TypeParamId[];
  }[];
  baseNominal?: TypeId;
}

export interface ObjectTemplate {
  symbol: SymbolId;
  params: readonly {
    symbol: SymbolId;
    typeParam: TypeParamId;
    constraint?: TypeId;
  }[];
  nominal: TypeId;
  structural: TypeId;
  type: TypeId;
  fields: readonly {
    name: string;
    type: TypeId;
    declaringParams?: readonly TypeParamId[];
  }[];
  baseNominal?: TypeId;
}

export interface TypeAliasTemplate {
  symbol: SymbolId;
  params: readonly { symbol: SymbolId; constraint?: HirTypeExpr }[];
  target: HirTypeExpr;
}

export const DEFAULT_EFFECT_ROW: EffectRowId = 0;
export const BASE_OBJECT_NAME = "Object";
