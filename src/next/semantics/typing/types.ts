import type { SymbolTable } from "../binder/index.js";
import type {
  HirExpression,
  HirFunction,
  HirGraph,
  HirObjectDecl,
  HirTraitDecl,
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
  functions: FunctionStore;
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

export class FunctionStore {
  #signatures = new Map<SymbolId, FunctionSignature>();
  #bySymbol = new Map<SymbolId, HirFunction>();
  #instances = new Map<string, TypeId>();
  #instantiationInfo = new Map<SymbolId, Map<string, readonly TypeId[]>>();
  #instanceExprTypes = new Map<string, Map<HirExprId, TypeId>>();
  #activeInstantiations = new Set<string>();

  register(fn: HirFunction): void {
    this.#bySymbol.set(fn.symbol, fn);
  }

  setSignature(symbol: SymbolId, signature: FunctionSignature): void {
    this.#signatures.set(symbol, signature);
  }

  getSignature(symbol: SymbolId): FunctionSignature | undefined {
    return this.#signatures.get(symbol);
  }

  get signatures(): IterableIterator<[SymbolId, FunctionSignature]> {
    return this.#signatures.entries();
  }

  getFunction(symbol: SymbolId): HirFunction | undefined {
    return this.#bySymbol.get(symbol);
  }

  isCachedOrActive(key: string): boolean {
    return this.#instances.has(key) || this.#activeInstantiations.has(key);
  }

  beginInstantiation(key: string): void {
    this.#activeInstantiations.add(key);
  }

  endInstantiation(key: string): void {
    this.#activeInstantiations.delete(key);
  }

  cacheInstance(
    key: string,
    returnType: TypeId,
    exprTypes: ReadonlyMap<HirExprId, TypeId>
  ): void {
    this.#instances.set(key, returnType);
    this.#instanceExprTypes.set(key, new Map(exprTypes));
  }

  getInstance(key: string): TypeId | undefined {
    return this.#instances.get(key);
  }

  getInstanceExprTypes(key: string): ReadonlyMap<HirExprId, TypeId> | undefined {
    return this.#instanceExprTypes.get(key);
  }

  recordInstantiation(
    symbol: SymbolId,
    key: string,
    typeArgs: readonly TypeId[]
  ): void {
    let bySymbol = this.#instantiationInfo.get(symbol);
    if (!bySymbol) {
      bySymbol = new Map();
      this.#instantiationInfo.set(symbol, bySymbol);
    }
    if (!bySymbol.has(key)) {
      bySymbol.set(key, typeArgs);
    }
  }

  resetInstances(): void {
    this.#instances.clear();
    this.#instantiationInfo.clear();
    this.#instanceExprTypes.clear();
    this.#activeInstantiations.clear();
  }

  snapshotInstances(): Map<string, TypeId> {
    return new Map(this.#instances);
  }

  snapshotInstantiationInfo(): Map<SymbolId, Map<string, readonly TypeId[]>> {
    return new Map(
      Array.from(this.#instantiationInfo.entries()).map(([symbol, info]) => [
        symbol,
        new Map(info),
      ])
    );
  }

  snapshotInstanceExprTypes(): Map<string, Map<HirExprId, TypeId>> {
    return new Map(
      Array.from(this.#instanceExprTypes.entries()).map(([key, exprs]) => [
        key,
        new Map(exprs),
      ])
    );
  }
}

export interface BaseObjectInfo {
  symbol: SymbolId;
  nominal: TypeId;
  structural: TypeId;
  type: TypeId;
}

export class ObjectStore {
  #templates = new Map<SymbolId, ObjectTemplate>();
  #instances = new Map<string, ObjectTypeInfo>();
  #byName = new Map<string, SymbolId>();
  #byNominal = new Map<TypeId, ObjectTypeInfo>();
  #decls = new Map<SymbolId, HirObjectDecl>();
  #resolving = new Set<SymbolId>();
  #base: BaseObjectInfo = { symbol: -1, nominal: -1, structural: -1, type: -1 };

  setBase(info: BaseObjectInfo): void {
    this.#base = info;
  }

  get base(): BaseObjectInfo {
    return this.#base;
  }

  registerTemplate(template: ObjectTemplate): void {
    this.#templates.set(template.symbol, template);
  }

  getTemplate(symbol: SymbolId): ObjectTemplate | undefined {
    return this.#templates.get(symbol);
  }

  templates(): IterableIterator<ObjectTemplate> {
    return this.#templates.values();
  }

  addInstance(key: string, info: ObjectTypeInfo): void {
    this.#instances.set(key, info);
    this.#byNominal.set(info.nominal, info);
  }

  hasInstance(key: string): boolean {
    return this.#instances.has(key);
  }

  getInstance(key: string): ObjectTypeInfo | undefined {
    return this.#instances.get(key);
  }

  getInstanceByNominal(nominal: TypeId): ObjectTypeInfo | undefined {
    return this.#byNominal.get(nominal);
  }

  hasNominal(nominal: TypeId): boolean {
    return this.#byNominal.has(nominal);
  }

  instanceEntries(): IterableIterator<[string, ObjectTypeInfo]> {
    return this.#instances.entries();
  }

  snapshotByNominal(): Map<TypeId, ObjectTypeInfo> {
    return new Map(this.#byNominal);
  }

  registerDecl(decl: HirObjectDecl): void {
    this.#decls.set(decl.symbol, decl);
  }

  getDecl(symbol: SymbolId): HirObjectDecl | undefined {
    return this.#decls.get(symbol);
  }

  hasDecl(symbol: SymbolId): boolean {
    return this.#decls.has(symbol);
  }

  setName(name: string, symbol: SymbolId): void {
    this.#byName.set(name, symbol);
  }

  hasName(name: string): boolean {
    return this.#byName.has(name);
  }

  resolveName(name: string): SymbolId | undefined {
    return this.#byName.get(name);
  }

  beginResolving(symbol: SymbolId): void {
    this.#resolving.add(symbol);
  }

  endResolving(symbol: SymbolId): void {
    this.#resolving.delete(symbol);
  }

  isResolving(symbol: SymbolId): boolean {
    return this.#resolving.has(symbol);
  }
}

export class TraitStore {
  #decls = new Map<SymbolId, HirTraitDecl>();
  #byName = new Map<string, SymbolId>();

  registerDecl(decl: HirTraitDecl): void {
    this.#decls.set(decl.symbol, decl);
  }

  getDecl(symbol: SymbolId): HirTraitDecl | undefined {
    return this.#decls.get(symbol);
  }

  setName(name: string, symbol: SymbolId): void {
    this.#byName.set(name, symbol);
  }

  hasName(name: string): boolean {
    return this.#byName.has(name);
  }

  resolveName(name: string): SymbolId | undefined {
    return this.#byName.get(name);
  }
}

export class TypeAliasStore {
  #templates = new Map<SymbolId, TypeAliasTemplate>();
  #instances = new Map<string, TypeId>();
  #instanceSymbols = new Map<TypeId, Set<SymbolId>>();
  #validatedInstances = new Set<string>();
  #byName = new Map<string, SymbolId>();
  #resolving = new Map<string, TypeId>();
  #resolvingKeysById = new Map<TypeId, string>();
  #failedInstantiations = new Set<string>();

  registerTemplate(template: TypeAliasTemplate): void {
    this.#templates.set(template.symbol, template);
  }

  getTemplate(symbol: SymbolId): TypeAliasTemplate | undefined {
    return this.#templates.get(symbol);
  }

  hasTemplate(symbol: SymbolId): boolean {
    return this.#templates.has(symbol);
  }

  templates(): IterableIterator<TypeAliasTemplate> {
    return this.#templates.values();
  }

  setName(name: string, symbol: SymbolId): void {
    this.#byName.set(name, symbol);
  }

  resolveName(name: string): SymbolId | undefined {
    return this.#byName.get(name);
  }

  hasFailed(key: string): boolean {
    return this.#failedInstantiations.has(key);
  }

  markFailed(key: string): void {
    this.#failedInstantiations.add(key);
  }

  getCachedInstance(key: string): TypeId | undefined {
    return this.#instances.get(key);
  }

  cacheInstance(key: string, type: TypeId): void {
    this.#instances.set(key, type);
  }

  hasInstance(key: string): boolean {
    return this.#instances.has(key);
  }

  instanceCount(): number {
    return this.#instances.size;
  }

  markValidated(key: string): void {
    this.#validatedInstances.add(key);
  }

  isValidated(key: string): boolean {
    return this.#validatedInstances.has(key);
  }

  beginResolution(key: string, placeholder: TypeId): void {
    this.#resolving.set(key, placeholder);
    this.#resolvingKeysById.set(placeholder, key);
  }

  getActiveResolution(key: string): TypeId | undefined {
    return this.#resolving.get(key);
  }

  getResolutionKey(type: TypeId): string | undefined {
    return this.#resolvingKeysById.get(type);
  }

  endResolution(key: string): TypeId | undefined {
    const placeholder = this.#resolving.get(key);
    this.#resolving.delete(key);
    if (typeof placeholder === "number") {
      this.#resolvingKeysById.delete(placeholder);
    }
    return placeholder;
  }

  resolutionDepth(): number {
    return this.#resolving.size;
  }

  recordInstanceSymbol(type: TypeId, symbol: SymbolId): void {
    const existing = this.#instanceSymbols.get(type);
    if (existing) {
      existing.add(symbol);
      return;
    }
    this.#instanceSymbols.set(type, new Set([symbol]));
  }

  getInstanceSymbols(type: TypeId): ReadonlySet<SymbolId> | undefined {
    return this.#instanceSymbols.get(type);
  }

  instanceEntries(): IterableIterator<[string, TypeId]> {
    return this.#instances.entries();
  }
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
  traits: TraitStore;
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
