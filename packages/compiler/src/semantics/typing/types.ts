import type { SymbolTable } from "../binder/index.js";
import type {
  HirFunction,
  HirGraph,
  HirObjectDecl,
  HirTraitDecl,
  HirTypeExpr,
  HirBindingKind,
  HirVisibility,
  HirEffectHandlerClause,
} from "../hir/index.js";
import type { ModuleExportTable } from "../modules.js";
import type {
  EffectRowId,
  HirExprId,
  OverloadSetId,
  SymbolId,
  TypeId,
  TypeParamId,
  TypeSchemeId,
  SourceSpan,
} from "../ids.js";
import type { EffectTable } from "../effects/effect-table.js";
import { DeclTable } from "../decls.js";
import type { StructuralField, TypeArena } from "./type-arena.js";
import type { TypeTable } from "./type-table.js";
import { DiagnosticEmitter } from "../../diagnostics/index.js";
import type { Diagnostic } from "../ids.js";
import type { SymbolRef } from "./symbol-ref.js";

export type TypeCheckMode = "relaxed" | "strict";
export type SymbolRefKey = string;

export interface TypeCheckBudgetConfig {
  maxUnifySteps?: number;
  maxOverloadCandidates?: number;
}

export interface TypeCheckBudgetState {
  maxUnifySteps: number;
  maxOverloadCandidates: number;
  unifyStepsUsed: { value: number };
}

export interface TypingInputs {
  symbolTable: SymbolTable;
  hir: HirGraph;
  overloads: ReadonlyMap<OverloadSetId, readonly SymbolId[]>;
  recoverDiagnosticErrors?: boolean;
  decls?: DeclTable;
  arena?: TypeArena;
  effects?: EffectTable;
  imports?: readonly {
    local: SymbolId;
    target?: { moduleId: string; symbol: SymbolId };
  }[];
  moduleId?: string;
  packageId?: string;
  moduleExports?: Map<string, ModuleExportTable>;
  availableSemantics?: Map<string, DependencySemantics>;
  typeCheckBudget?: TypeCheckBudgetConfig;
}

export interface TypingResult {
  arena: TypeArena;
  table: TypeTable;
  functions: FunctionStore;
  typeAliases: TypeAliasStore;
  objects: ObjectStore;
  traits: TraitStore;
  memberMetadata: ReadonlyMap<SymbolId, MemberMetadata>;
  primitives: PrimitiveTypes;
  intrinsicTypes: Map<string, TypeId>;
  effects: EffectTable;
  resolvedExprTypes: ReadonlyMap<HirExprId, TypeId>;
  valueTypes: ReadonlyMap<SymbolId, TypeId>;
  tailResumptions: ReadonlyMap<HirExprId, HirEffectHandlerClause["tailResumption"]>;
  objectsByNominal: ReadonlyMap<TypeId, ObjectTypeInfo>;
  callTargets: ReadonlyMap<HirExprId, ReadonlyMap<string, SymbolRef>>;
  functionInstances: ReadonlyMap<string, TypeId>;
  callTypeArguments: ReadonlyMap<HirExprId, ReadonlyMap<string, readonly TypeId[]>>;
  callInstanceKeys: ReadonlyMap<HirExprId, ReadonlyMap<string, string>>;
  callTraitDispatches: ReadonlySet<HirExprId>;
  functionInstantiationInfo: ReadonlyMap<
    SymbolRefKey,
    ReadonlyMap<string, readonly TypeId[]>
  >;
  functionInstanceExprTypes: ReadonlyMap<string, ReadonlyMap<HirExprId, TypeId>>;
  functionInstanceValueTypes: ReadonlyMap<string, ReadonlyMap<SymbolId, TypeId>>;
  traitImplsByNominal: ReadonlyMap<TypeId, readonly TraitImplInstance[]>;
  traitImplsByTrait: ReadonlyMap<SymbolId, readonly TraitImplInstance[]>;
  traitMethodImpls: ReadonlyMap<SymbolId, TraitMethodImpl>;
  diagnostics: readonly Diagnostic[];
}

export interface PrimitiveTypes {
  cache: Map<string, TypeId>;
  bool: TypeId;
  void: TypeId;
  unknown: TypeId;
  defaultEffectRow: EffectRowId;
  i32: TypeId;
  i64: TypeId;
  f32: TypeId;
  f64: TypeId;
}

export interface FunctionSignature {
  typeId: TypeId;
  parameters: readonly ParamSignature[];
  returnType: TypeId;
  hasExplicitReturn: boolean;
  annotatedReturn: boolean;
  effectRow: EffectRowId;
  annotatedEffects: boolean;
  typeParams?: readonly FunctionTypeParam[];
  scheme: TypeSchemeId;
  typeParamMap?: ReadonlyMap<SymbolId, TypeId>;
}

export interface ParamSignature {
  type: TypeId;
  label?: string;
  bindingKind?: HirBindingKind;
  span?: SourceSpan;
  name?: string;
  symbol?: SymbolId;
  optional?: boolean;
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
  exprId?: HirExprId;
}

export interface CallResolution {
  targets: Map<HirExprId, Map<string, SymbolRef>>;
  typeArguments: Map<HirExprId, Map<string, readonly TypeId[]>>;
  instanceKeys: Map<HirExprId, Map<string, string>>;
  traitDispatches: Set<HirExprId>;
}

export class FunctionStore {
  #signatures = new Map<SymbolId, FunctionSignature>();
  #bySymbol = new Map<SymbolId, HirFunction>();
  #instances = new Map<string, TypeId>();
  #instantiationInfo = new Map<SymbolRefKey, Map<string, readonly TypeId[]>>();
  #instanceExprTypes = new Map<string, Map<HirExprId, TypeId>>();
  #instanceValueTypes = new Map<string, Map<SymbolId, TypeId>>();
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

  cacheInstanceValueTypes(
    key: string,
    valueTypes: ReadonlyMap<SymbolId, TypeId>
  ): void {
    this.#instanceValueTypes.set(key, new Map(valueTypes));
  }

  getInstance(key: string): TypeId | undefined {
    return this.#instances.get(key);
  }

  getInstanceExprTypes(key: string): ReadonlyMap<HirExprId, TypeId> | undefined {
    return this.#instanceExprTypes.get(key);
  }

  getInstanceValueTypes(key: string): ReadonlyMap<SymbolId, TypeId> | undefined {
    return this.#instanceValueTypes.get(key);
  }

  recordInstantiation(
    symbolRefKey: SymbolRefKey,
    key: string,
    typeArgs: readonly TypeId[]
  ): void {
    let bySymbol = this.#instantiationInfo.get(symbolRefKey);
    if (!bySymbol) {
      bySymbol = new Map();
      this.#instantiationInfo.set(symbolRefKey, bySymbol);
    }
    if (!bySymbol.has(key)) {
      bySymbol.set(key, typeArgs);
    }
  }

  resetInstances(): void {
    this.#instances.clear();
    this.#instantiationInfo.clear();
    this.#instanceExprTypes.clear();
    this.#instanceValueTypes.clear();
    this.#activeInstantiations.clear();
  }

  snapshotInstances(): Map<string, TypeId> {
    return new Map(this.#instances);
  }

  snapshotInstantiationInfo(): Map<SymbolRefKey, Map<string, readonly TypeId[]>> {
    return new Map(
      Array.from(this.#instantiationInfo.entries()).map(([symbolRefKey, info]) => [
        symbolRefKey,
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

  snapshotInstanceValueTypes(): Map<string, Map<SymbolId, TypeId>> {
    return new Map(
      Array.from(this.#instanceValueTypes.entries()).map(([key, types]) => [
        key,
        new Map(types),
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
  #implTemplates: TraitImplTemplate[] = [];
  #implTemplatesByTrait = new Map<SymbolId, TraitImplTemplate[]>();

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

  registerImplTemplate(template: TraitImplTemplate): void {
    this.#implTemplates.push(template);
    const bucket = this.#implTemplatesByTrait.get(template.traitSymbol) ?? [];
    bucket.push(template);
    this.#implTemplatesByTrait.set(template.traitSymbol, bucket);
  }

  registerImplTemplateChecked({
    template,
    conflictsWith,
  }: {
    template: TraitImplTemplate;
    conflictsWith: (
      existing: TraitImplTemplate,
      candidate: TraitImplTemplate
    ) => boolean;
  }): TraitImplTemplate | undefined {
    const conflict = this.getImplTemplatesForTrait(template.traitSymbol).find(
      (existing) => conflictsWith(existing, template)
    );
    if (conflict) {
      return conflict;
    }
    this.registerImplTemplate(template);
    return undefined;
  }

  getImplTemplates(): readonly TraitImplTemplate[] {
    return this.#implTemplates;
  }

  getImplTemplatesForTrait(symbol: SymbolId): readonly TraitImplTemplate[] {
    return this.#implTemplatesByTrait.get(symbol) ?? [];
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

  instanceSymbolEntries(): IterableIterator<[TypeId, ReadonlySet<SymbolId>]> {
    return this.#instanceSymbols.entries();
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
  memberOf?: SymbolId;
  functionSymbol?: SymbolId;
  observedReturnType?: TypeId;
}

export interface TypingState {
  mode: TypeCheckMode;
  currentFunction?: FunctionScope;
}

export interface MemberMetadata {
  owner?: SymbolId;
  visibility?: HirVisibility;
  packageId?: string;
}

export interface TypingContext {
  symbolTable: SymbolTable;
  hir: HirGraph;
  overloads: ReadonlyMap<OverloadSetId, readonly SymbolId[]>;
  typeCheckBudget: TypeCheckBudgetState;
  decls: DeclTable;
  moduleId: string;
  packageId: string;
  moduleExports: Map<string, ModuleExportTable>;
  dependencies: Map<string, DependencySemantics>;
  importsByLocal: Map<SymbolId, { moduleId: string; symbol: SymbolId }>;
  importAliasesByModule: Map<string, Map<SymbolId, SymbolId>>;
  arena: TypeArena;
  table: TypeTable;
  effects: EffectTable;
  resolvedExprTypes: Map<HirExprId, TypeId>;
  valueTypes: Map<SymbolId, TypeId>;
  /** Symbols currently being typed; used for better diagnostics (e.g. self-referential let initializers). */
  activeValueTypeComputations: Set<SymbolId>;
  tailResumptions: Map<HirExprId, HirEffectHandlerClause["tailResumption"]>;
  callResolution: CallResolution;
  functions: FunctionStore;
  objects: ObjectStore;
  traits: TraitStore;
  typeAliases: TypeAliasStore;
  primitives: PrimitiveTypes;
  intrinsicTypes: Map<string, TypeId>;
  diagnostics: DiagnosticEmitter;
  memberMetadata: Map<SymbolId, MemberMetadata>;
  traitImplsByNominal: Map<TypeId, readonly TraitImplInstance[]>;
  traitImplsByTrait: Map<SymbolId, readonly TraitImplInstance[]>;
  traitMethodImpls: Map<SymbolId, TraitMethodImpl>;
}

export interface ObjectTypeInfo {
  nominal: TypeId;
  structural: TypeId;
  type: TypeId;
  fields: readonly StructuralField[];
  visibility?: HirVisibility;
  baseNominal?: TypeId;
  traitImpls?: readonly TraitImplInstance[];
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
  fields: readonly StructuralField[];
  visibility?: HirVisibility;
  baseNominal?: TypeId;
}

export interface TypeAliasTemplate {
  symbol: SymbolId;
  params: readonly { symbol: SymbolId; constraint?: HirTypeExpr }[];
  target: HirTypeExpr;
}

export interface DependencySemantics {
  moduleId: string;
  packageId: string;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
  decls: DeclTable;
  overloads: ReadonlyMap<OverloadSetId, readonly SymbolId[]>;
  exports: ModuleExportTable;
}

export interface TraitMethodImpl {
  traitSymbol: SymbolId;
  traitMethodSymbol: SymbolId;
}

export interface TraitImplTemplate {
  trait: TypeId;
  traitSymbol: SymbolId;
  target: TypeId;
  typeParams: readonly FunctionTypeParam[];
  methods: ReadonlyMap<SymbolId, SymbolId>;
  implSymbol: SymbolId;
}

export interface TraitImplInstance {
  trait: TypeId;
  traitSymbol: SymbolId;
  target: TypeId;
  methods: ReadonlyMap<SymbolId, SymbolId>;
  implSymbol: SymbolId;
}

export const DEFAULT_EFFECT_ROW: EffectRowId = 0;
export const BASE_OBJECT_NAME = "Object";
