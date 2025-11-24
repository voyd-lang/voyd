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

export type TypeCheckMode = "relaxed" | "strict";

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

export interface PrimitiveTypes {
  cache: Map<string, TypeId>;
  bool: TypeId;
  void: TypeId;
  unknown: TypeId;
  defaultEffectRow: EffectRowId;
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

export interface CallResolution {
  targets: Map<HirExprId, Map<string, SymbolId>>;
  typeArguments: Map<HirExprId, readonly TypeId[]>;
  instanceKeys: Map<HirExprId, string>;
}

export interface FunctionStore {
  signatures: Map<SymbolId, FunctionSignature>;
  bySymbol: Map<SymbolId, HirFunction>;
  instances: Map<string, TypeId>;
  instantiationInfo: Map<SymbolId, Map<string, readonly TypeId[]>>;
  instanceExprTypes: Map<string, Map<HirExprId, TypeId>>;
  activeInstantiations: Set<string>;
}

export interface ObjectStore {
  templates: Map<SymbolId, ObjectTemplate>;
  instances: Map<string, ObjectTypeInfo>;
  byName: Map<string, SymbolId>;
  byNominal: Map<TypeId, ObjectTypeInfo>;
  decls: Map<SymbolId, HirObjectDecl>;
  resolving: Set<SymbolId>;
  base: {
    symbol: SymbolId;
    nominal: TypeId;
    structural: TypeId;
    type: TypeId;
  };
}

export interface TypeAliasStore {
  templates: Map<SymbolId, TypeAliasTemplate>;
  instances: Map<string, TypeId>;
  instanceSymbols: Map<TypeId, Set<SymbolId>>;
  validatedInstances: Set<string>;
  byName: Map<string, SymbolId>;
  resolving: Map<string, TypeId>;
  resolvingKeysById: Map<TypeId, string>;
  failedInstantiations: Set<string>;
}

export interface FunctionScope {
  returnType: TypeId;
  instanceKey?: string;
  typeParams?: ReadonlyMap<SymbolId, TypeId>;
  substitution?: ReadonlyMap<TypeParamId, TypeId>;
}

export interface TypingState {
  mode: TypeCheckMode;
  currentFunction?: FunctionScope;
}

export interface TypingContext {
  symbolTable: SymbolTable;
  hir: HirGraph;
  overloads: ReadonlyMap<OverloadSetId, readonly SymbolId[]>;
  decls: DeclTable;
  arena: TypeArena;
  table: TypeTable;
  resolvedExprTypes: Map<HirExprId, TypeId>;
  valueTypes: Map<SymbolId, TypeId>;
  callResolution: CallResolution;
  functions: FunctionStore;
  objects: ObjectStore;
  typeAliases: TypeAliasStore;
  primitives: PrimitiveTypes;
  intrinsicTypes: Map<string, TypeId>;
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
