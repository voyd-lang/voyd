import type { HirGraph, HirEffectHandlerClause, HirVisibility } from "../hir/index.js";
import type { EffectInterner } from "../effects/effect-table.js";
import type { EffectTable } from "../effects/effect-table.js";
import type {
  HirExprId,
  NodeId,
  ProgramFunctionId,
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  SymbolId,
  TypeId,
  TypeParamId,
  TypeSchemeId,
} from "../ids.js";
import type {
  ConstraintSet,
  StructuralField,
  Substitution,
  TypeDescriptor,
  TypeScheme,
  UnificationContext,
  UnificationResult,
} from "../typing/type-arena.js";
import type { SemanticsPipelineResult } from "../pipeline.js";
import { buildEffectsLoweringInfo } from "../effects/analysis.js";
import type { EffectsLoweringInfo } from "../effects/analysis.js";
import { getSymbolTable } from "../_internal/symbol-table.js";
import type { SymbolRef as TypingSymbolRef } from "../typing/symbol-ref.js";
import type {
  ObjectTemplate,
  ObjectTypeInfo,
  SymbolRefKey,
  TraitImplInstance,
} from "../typing/types.js";
import { cloneNestedMap } from "../typing/call-resolution.js";
import {
  getOptionalInfo,
  type OptionalResolverContext,
} from "../typing/optionals.js";
import { buildProgramSymbolArena } from "../program-symbol-arena.js";
import type { ProgramSymbolArena, SymbolRef } from "../program-symbol-arena.js";
import { createCanonicalSymbolRefResolver } from "../canonical-symbol-ref.js";
import { parseSymbolRefKey } from "../typing/symbol-ref-utils.js";

export type { SymbolRef } from "../program-symbol-arena.js";

export type CodegenStructuralField = {
  name: string;
  type: TypeId;
  optional?: boolean;
  declaringParams?: readonly TypeParamId[];
  visibility?: HirVisibility;
  owner?: SymbolId;
  packageId?: string;
};

export type CodegenFunctionParameter = {
  type: TypeId;
  label?: string;
  optional?: boolean;
};

export type CodegenTypeDesc =
  | { kind: "primitive"; name: string }
  | { kind: "recursive"; binder: TypeParamId; body: TypeId }
  | { kind: "trait"; owner: ProgramSymbolId; name?: string; typeArgs: readonly TypeId[] }
  | { kind: "nominal-object"; owner: ProgramSymbolId; name?: string; typeArgs: readonly TypeId[] }
  | { kind: "structural-object"; fields: readonly CodegenStructuralField[] }
  | { kind: "function"; parameters: readonly CodegenFunctionParameter[]; returnType: TypeId; effectRow: number }
  | { kind: "union"; members: readonly TypeId[] }
  | {
      kind: "intersection";
      nominal?: TypeId;
      structural?: TypeId;
      traits?: readonly TypeId[];
    }
  | { kind: "fixed-array"; element: TypeId }
  | { kind: "type-param-ref"; param: TypeParamId };

export type CodegenStructuralPredicate = {
  field: string;
  type: TypeId;
};

export type CodegenConstraintSet = {
  traits?: readonly TypeId[];
  structural?: readonly CodegenStructuralPredicate[];
};

export type CodegenVariance = "invariant" | "covariant" | "contravariant";

export type CodegenSubstitution = ReadonlyMap<TypeParamId, TypeId>;

export type CodegenTypeScheme = {
  id: TypeSchemeId;
  params: readonly TypeParamId[];
  body: TypeId;
  constraints?: CodegenConstraintSet;
};

export type CodegenUnificationContext = {
  location: NodeId;
  reason: string;
  variance?: CodegenVariance;
  constraints?: ReadonlyMap<TypeParamId, CodegenConstraintSet>;
  allowUnknown?: boolean;
  structuralResolver?: (type: TypeId) => TypeId | undefined;
};

export type CodegenUnificationResult =
  | { ok: true; substitution: CodegenSubstitution }
  | { ok: false; conflict: { left: TypeId; right: TypeId; message: string } };

export type CodegenOptionalInfo = {
  optionalType: TypeId;
  innerType: TypeId;
  someType: TypeId;
  noneType: TypeId;
};

export type StructuralLayout =
  | { kind: "structural-object"; fields: readonly { name: string; typeId: TypeId; optional: boolean }[] }
  | { kind: "fixed-array"; element: TypeId }
  | { kind: "function"; params: readonly TypeId[]; result: TypeId }
  | { kind: "primitive"; name: string }
  | { kind: "other"; kindName: CodegenTypeDesc["kind"] };

export type CallLoweringInfo = {
  targets?: ReadonlyMap<ProgramFunctionInstanceId, ProgramFunctionId>;
  typeArgs?: ReadonlyMap<ProgramFunctionInstanceId, readonly TypeId[]>;
  traitDispatch: boolean;
};

export type CodegenFunctionSignature = {
  typeId: TypeId;
  scheme: TypeSchemeId;
  parameters: readonly {
    typeId: TypeId;
    label?: string;
    optional: boolean;
    name?: string;
    symbol?: SymbolId;
  }[];
  returnType: TypeId;
  effectRow: number;
  typeParams: readonly {
    symbol: SymbolId;
    typeParam: TypeParamId;
    typeRef: TypeId;
    constraint?: TypeId;
  }[];
};

export type FunctionLoweringIndex = {
  getSignature(moduleId: string, symbol: SymbolId): CodegenFunctionSignature | undefined;
  getInstantiationInfo(
    moduleId: string,
    symbol: SymbolId
  ): ReadonlyMap<ProgramFunctionInstanceId, readonly TypeId[]> | undefined;
  getInstanceExprType(
    instanceId: ProgramFunctionInstanceId,
    expr: HirExprId
  ): TypeId | undefined;
  getInstanceValueType(
    instanceId: ProgramFunctionInstanceId,
    symbol: SymbolId
  ): TypeId | undefined;
  getFunctionId(ref: SymbolRef): ProgramFunctionId | undefined;
  getInstanceId(
    moduleId: string,
    symbol: SymbolId,
    typeArgs: readonly TypeId[] | undefined
  ): ProgramFunctionInstanceId | undefined;
  getFunctionRef(functionId: ProgramFunctionId): SymbolRef | undefined;
  getInstance(instanceId: ProgramFunctionInstanceId): {
    functionId: ProgramFunctionId;
    typeArgs: readonly TypeId[];
    symbolRef: SymbolRef;
  };
  formatInstance(instanceId: ProgramFunctionInstanceId): string;
};

export type ModuleTypeIndex = {
  getExprType(expr: HirExprId): TypeId;
  getResolvedExprType(expr: HirExprId): TypeId | undefined;
  getValueType(symbol: SymbolId): TypeId | undefined;
  getTailResumption(expr: HirExprId): HirEffectHandlerClause["tailResumption"] | undefined;
};

export type MonomorphizedInstanceInfo = {
  callee: ProgramFunctionId;
  typeArgs: readonly TypeId[];
  instanceId: ProgramFunctionInstanceId;
};

export type MonomorphizedInstanceRequest = {
  callee: SymbolRef;
  typeArgs: readonly TypeId[];
};

export type TypeLoweringIndex = {
  getTypeDesc(typeId: TypeId): CodegenTypeDesc;
  getScheme(schemeId: TypeSchemeId): CodegenTypeScheme;
  instantiate(
    schemeId: TypeSchemeId,
    args: readonly TypeId[],
    ctx?: CodegenUnificationContext
  ): TypeId;
  unify(a: TypeId, b: TypeId, ctx: CodegenUnificationContext): CodegenUnificationResult;
  substitute(typeId: TypeId, subst: Substitution): TypeId;
  getNominalOwner(typeId: TypeId): ProgramSymbolId | undefined;
  getNominalAncestry(typeId: TypeId): readonly { nominalId: TypeId; typeId: TypeId }[];
  getStructuralLayout(typeId: TypeId): StructuralLayout | undefined;
  getRuntimeTypeId(typeId: TypeId): number;
  getAliasSymbols(typeId: TypeId): readonly ProgramSymbolId[];
};

export type ObjectLayoutIndex = {
  getTemplate(owner: ProgramSymbolId): CodegenObjectTemplate | undefined;
  getInfoByNominal(nominal: TypeId): CodegenObjectTypeInfo | undefined;
  getNominalOwnerRef(nominal: TypeId): ProgramSymbolId | undefined;
  getNominalInstancesByOwner(owner: ProgramSymbolId): readonly TypeId[];
};

export type TraitDispatchIndex = {
  getImplsByNominal(nominal: TypeId): readonly CodegenTraitImplInstance[];
  getImplsByTrait(traitSymbol: ProgramSymbolId): readonly CodegenTraitImplInstance[];
  getImplTemplates(): readonly CodegenTraitImplTemplate[];
  getTraitMethodImpl(symbol: ProgramSymbolId): CodegenTraitMethodImpl | undefined;
};

export type CallLoweringIndex = {
  getCallInfo(moduleId: string, expr: HirExprId): CallLoweringInfo;
};

export type MonomorphizedInstanceIndex = {
  getAll(): readonly MonomorphizedInstanceInfo[];
  getById(instanceId: ProgramFunctionInstanceId): MonomorphizedInstanceInfo | undefined;
};

export type ModuleCodegenMetadata = {
  moduleId: string;
  packageId: string;
  isPackageRoot: boolean;
  imports: readonly {
    local: SymbolId;
  }[];
  effects: readonly {
    name: string;
    effectId?: string;
    visibility: HirVisibility;
    symbol: SymbolId;
    operations: readonly {
      name: string;
      resumable: "resume" | "tail";
      symbol: SymbolId;
    }[];
  }[];
};

export type ModuleCodegenView = {
  moduleId: string;
  meta: ModuleCodegenMetadata;
  hir: HirGraph;
  effects: EffectTable;
  types: ModuleTypeIndex;
  effectsInfo: EffectsLoweringInfo;
};

export type ImportWiringIndex = {
  getLocal(moduleId: string, target: ProgramSymbolId): SymbolId | undefined;
  getTarget(moduleId: string, local: SymbolId): ProgramSymbolId | undefined;
};

export type ProgramEffectIndex = {
  getOrderedModules(): readonly string[];
  getGlobalId(moduleId: string, localEffectIndex: number): number | undefined;
  getByGlobalId(
    effectId: number
  ): { moduleId: string; localEffectIndex: number } | undefined;
  getEffectCount(): number;
};

export type ProgramCodegenView = {
  effects: EffectInterner & ProgramEffectIndex;
  primitives: {
    bool: TypeId;
    void: TypeId;
    unknown: TypeId;
    defaultEffectRow: number;
    i32: TypeId;
    i64: TypeId;
    f32: TypeId;
    f64: TypeId;
  };
  types: TypeLoweringIndex;
  symbols: ProgramSymbolArena & {
    canonicalIdOf(moduleId: string, symbol: SymbolId): ProgramSymbolId;
  };
  functions: FunctionLoweringIndex;
  optionals: {
    getOptionalInfo(moduleId: string, typeId: TypeId): CodegenOptionalInfo | undefined;
  };
  objects: ObjectLayoutIndex;
  traits: TraitDispatchIndex;
  calls: CallLoweringIndex;
  instances: MonomorphizedInstanceIndex;
  imports: ImportWiringIndex;
  modules: ReadonlyMap<string, ModuleCodegenView>;
};

export type CodegenObjectTemplate = {
  symbol: ProgramSymbolId;
  params: readonly { symbol: SymbolId; typeParam: TypeParamId; constraint?: TypeId }[];
  nominal: TypeId;
  structural: TypeId;
  type: TypeId;
  fields: readonly CodegenStructuralField[];
  visibility?: HirVisibility;
  baseNominal?: TypeId;
};

export type CodegenObjectTypeInfo = {
  nominal: TypeId;
  structural: TypeId;
  type: TypeId;
  fields: readonly CodegenStructuralField[];
  visibility?: HirVisibility;
  baseNominal?: TypeId;
  traitImpls?: readonly CodegenTraitImplInstance[];
};

export type CodegenTraitMethodImpl = {
  traitSymbol: ProgramSymbolId;
  traitMethodSymbol: ProgramSymbolId;
};

export type CodegenTraitImplTemplate = {
  trait: TypeId;
  traitSymbol: ProgramSymbolId;
  target: TypeId;
  methods: readonly { traitMethod: ProgramSymbolId; implMethod: ProgramSymbolId }[];
  implSymbol: ProgramSymbolId;
};

export type CodegenTraitImplInstance = {
  trait: TypeId;
  traitSymbol: ProgramSymbolId;
  target: TypeId;
  methods: readonly { traitMethod: ProgramSymbolId; implMethod: ProgramSymbolId }[];
  implSymbol: ProgramSymbolId;
};

export const buildProgramCodegenView = (
  modules: readonly SemanticsPipelineResult[],
  options?: {
    instances?: readonly MonomorphizedInstanceRequest[];
	    moduleTyping?: ReadonlyMap<
	      string,
	      {
	        functionInstantiationInfo: ReadonlyMap<SymbolRefKey, ReadonlyMap<string, readonly TypeId[]>>;
	        functionInstanceExprTypes: ReadonlyMap<string, ReadonlyMap<HirExprId, TypeId>>;
	        functionInstanceValueTypes: ReadonlyMap<string, ReadonlyMap<SymbolId, TypeId>>;
	        callTargets: ReadonlyMap<HirExprId, ReadonlyMap<string, TypingSymbolRef>>;
	        callTypeArguments: ReadonlyMap<HirExprId, ReadonlyMap<string, readonly TypeId[]>>;
	        callInstanceKeys: ReadonlyMap<HirExprId, ReadonlyMap<string, string>>;
	        callTraitDispatches: ReadonlySet<HirExprId>;
	        valueTypes: ReadonlyMap<SymbolId, TypeId>;
	      }
	    >;
	  }
): ProgramCodegenView => {
  type ModuleTypingOverride = NonNullable<NonNullable<typeof options>["moduleTyping"]> extends ReadonlyMap<
    string,
    infer Entry
  >
    ? Entry
    : never;
  const modulesById = new Map<string, SemanticsPipelineResult>(
    modules.map((mod) => [mod.moduleId, mod] as const)
  );
  const moduleTyping: ReadonlyMap<string, ModuleTypingOverride> =
    options?.moduleTyping ?? new Map<string, ModuleTypingOverride>();
  const first = modules[0];
  if (!first) {
    throw new Error("buildProgramCodegenView requires at least one module");
  }

  const arena = first.typing.arena;
  const mismatchedArena = modules.find((mod) => mod.typing.arena !== arena);
  if (mismatchedArena) {
    throw new Error(
      `buildProgramCodegenView requires all modules to share a TypeArena; ` +
        `module ${mismatchedArena.moduleId} uses a different arena`
    );
  }
  const effectsInterner: EffectInterner = first.typing.effects;

  const objectTemplateByOwner = new Map<ProgramSymbolId, CodegenObjectTemplate>();
  const objectInfoByNominal = new Map<TypeId, CodegenObjectTypeInfo>();
  const nominalOwnerByNominal = new Map<TypeId, ProgramSymbolId>();
  const nominalsByOwner = new Map<ProgramSymbolId, TypeId[]>();
  const aliasSymbolsByType = new Map<TypeId, Set<ProgramSymbolId>>();

  const traitImplsByNominal = new Map<TypeId, CodegenTraitImplInstance[]>();
  const traitImplsByTrait = new Map<ProgramSymbolId, CodegenTraitImplInstance[]>();
  const traitMethodImpls = new Map<ProgramSymbolId, CodegenTraitMethodImpl>();
  const traitImplTemplates: CodegenTraitImplTemplate[] = [];

	  const callsByModuleRaw = new Map<
	    string,
	    {
	      targets: Map<HirExprId, ReadonlyMap<string, TypingSymbolRef>>;
	      typeArgs: Map<HirExprId, ReadonlyMap<string, readonly TypeId[]>>;
	      traitDispatches: Set<HirExprId>;
	    }
	  >();
	  const callsByModule = new Map<
	    string,
	    {
	      targets: Map<HirExprId, ReadonlyMap<ProgramFunctionInstanceId, ProgramFunctionId>>;
	      typeArgs: Map<HirExprId, ReadonlyMap<ProgramFunctionInstanceId, readonly TypeId[]>>;
	      traitDispatches: Set<HirExprId>;
	    }
	  >();

  const allInstances: MonomorphizedInstanceInfo[] = [];
  const instanceById = new Map<ProgramFunctionInstanceId, MonomorphizedInstanceInfo>();
  const instanceInfoById: {
    functionId: ProgramFunctionId;
    typeArgs: readonly TypeId[];
    symbolRef: SymbolRef;
  }[] = [];
  const instanceIdsByFunctionId = new Map<
    ProgramFunctionId,
    Map<string, ProgramFunctionInstanceId>
  >();
  const instantiationInfoByFunctionId = new Map<
    ProgramFunctionId,
    Map<ProgramFunctionInstanceId, readonly TypeId[]>
  >();

  const stableModules = [...modules].sort((a, b) =>
    a.moduleId.localeCompare(b.moduleId, undefined, { numeric: true })
  );

  const symbols = buildProgramSymbolArena(stableModules);

  stableModules.forEach((mod) => {
    for (const [typeId, symbolSet] of mod.typing.typeAliases.instanceSymbolEntries()) {
      const bucket = aliasSymbolsByType.get(typeId) ?? new Set<ProgramSymbolId>();
      symbolSet.forEach((symbol) => {
        bucket.add(symbols.idOf({ moduleId: mod.moduleId, symbol }));
      });
      aliasSymbolsByType.set(typeId, bucket);
    }
  });

  const moduleMetaById = new Map<string, ModuleCodegenMetadata>();
  const importTargetsByModule = new Map<string, Map<SymbolId, SymbolRef>>();
  const importTargetIdsByModule = new Map<string, Map<SymbolId, ProgramSymbolId>>();
  const importLocalsByModule = new Map<string, Map<ProgramSymbolId, SymbolId>>();

  const toSymbolRef = (ref: TypingSymbolRef): SymbolRef => ({
    moduleId: ref.moduleId,
    symbol: ref.symbol,
  });

  const typeDescCache = new Map<TypeId, CodegenTypeDesc>();
  const schemeCache = new Map<TypeSchemeId, CodegenTypeScheme>();
  const traitImplCache = new Map<string, CodegenTraitImplInstance>();

  const normalizeCallerInstanceKey = (key: string): string => {
    const lambdaIndex = key.indexOf("::lambda");
    return lambdaIndex >= 0 ? key.slice(0, lambdaIndex) : key;
  };

  const parseFunctionInstanceKey = (
    key: string
  ): { symbol: SymbolId; typeArgs: TypeId[] } | undefined => {
    const match = key.match(/^(\d+)<(.*)>$/);
    if (!match) return undefined;
    const symbol = Number(match[1]);
    if (!Number.isFinite(symbol)) return undefined;
    const argsSegment = match[2] ?? "";
    const typeArgs =
      argsSegment.length === 0
        ? []
        : argsSegment.split(",").map((value) => Number(value));
    if (typeArgs.some((arg) => !Number.isFinite(arg))) {
      return undefined;
    }
    return { symbol, typeArgs };
  };

  const compareTypeArgs = (left: readonly TypeId[], right: readonly TypeId[]): number => {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const diff = left[index]! - right[index]!;
      if (diff !== 0) return diff;
    }
    return left.length - right.length;
  };

  const instantiationsByFunctionId = new Map<
    ProgramFunctionId,
    Map<string, readonly TypeId[]>
  >();

  const typeContainsUnknownPrimitive = (typeId: TypeId, seen: Set<TypeId> = new Set()): boolean => {
    if (seen.has(typeId)) {
      return false;
    }
    seen.add(typeId);
    const desc = arena.get(typeId);
    switch (desc.kind) {
      case "primitive":
        return desc.name === "unknown";
      case "recursive":
        return typeContainsUnknownPrimitive(desc.body, seen);
      case "trait":
      case "nominal-object":
        return desc.typeArgs.some((arg) => typeContainsUnknownPrimitive(arg, seen));
      case "fixed-array":
        return typeContainsUnknownPrimitive(desc.element, seen);
      case "structural-object":
        return desc.fields.some((field) => typeContainsUnknownPrimitive(field.type, seen));
      case "function":
        return (
          desc.parameters.some((param) => typeContainsUnknownPrimitive(param.type, seen)) ||
          typeContainsUnknownPrimitive(desc.returnType, seen)
        );
      case "union":
        return desc.members.some((member) => typeContainsUnknownPrimitive(member, seen));
      case "intersection":
        return (
          (typeof desc.nominal === "number" && typeContainsUnknownPrimitive(desc.nominal, seen)) ||
          (typeof desc.structural === "number" &&
            typeContainsUnknownPrimitive(desc.structural, seen))
        );
      default:
        return false;
    }
  };

  const instantiationTypeArgsAreConcrete = (typeArgs: readonly TypeId[]): boolean => {
    if (typeArgs.length === 0) {
      return true;
    }
    if (typeArgs.some((typeArg) => arena.get(typeArg).kind === "type-param-ref")) {
      return false;
    }
    return !typeArgs.some((typeArg) => typeContainsUnknownPrimitive(typeArg));
  };

  const recordInstantiation = (
    functionId: ProgramFunctionId,
    typeArgs: readonly TypeId[],
  ): void => {
    if (!instantiationTypeArgsAreConcrete(typeArgs)) {
      return;
    }
    const key = typeArgs.join(",");
    const bucket = instantiationsByFunctionId.get(functionId) ?? new Map();
    if (!bucket.has(key)) {
      bucket.set(key, [...typeArgs]);
    }
    instantiationsByFunctionId.set(functionId, bucket);
  };

  const toCodegenStructuralField = (field: StructuralField): CodegenStructuralField => ({
    name: field.name,
    type: field.type,
    optional: field.optional === true,
    declaringParams: field.declaringParams,
    visibility: field.visibility,
    owner: field.owner,
    packageId: field.packageId,
  });

  const toCodegenTypeDesc = (typeId: TypeId, desc: TypeDescriptor): CodegenTypeDesc => {
    const cached = typeDescCache.get(typeId);
    if (cached) {
      return cached;
    }
    switch (desc.kind) {
      case "primitive":
        return cacheTypeDesc(typeId, { kind: "primitive", name: desc.name });
      case "recursive":
        return cacheTypeDesc(typeId, {
          kind: "recursive",
          binder: desc.binder,
          body: desc.body,
        });
      case "type-param-ref":
        return cacheTypeDesc(typeId, { kind: "type-param-ref", param: desc.param });
      case "trait":
        return cacheTypeDesc(typeId, {
          kind: "trait",
          owner: symbols.idOf(toSymbolRef(desc.owner)),
          name: desc.name,
          typeArgs: [...desc.typeArgs],
        });
      case "nominal-object":
        return cacheTypeDesc(typeId, {
          kind: "nominal-object",
          owner: symbols.idOf(toSymbolRef(desc.owner)),
          name: desc.name,
          typeArgs: [...desc.typeArgs],
        });
      case "structural-object":
        return cacheTypeDesc(typeId, {
          kind: "structural-object",
          fields: desc.fields.map(toCodegenStructuralField),
        });
      case "function":
        return cacheTypeDesc(typeId, {
          kind: "function",
          parameters: desc.parameters.map((param) => ({
            type: param.type,
            label: param.label,
            optional: param.optional === true,
          })),
          returnType: desc.returnType,
          effectRow: desc.effectRow,
        });
      case "union":
        return cacheTypeDesc(typeId, { kind: "union", members: [...desc.members] });
      case "intersection":
        return cacheTypeDesc(typeId, {
          kind: "intersection",
          nominal: desc.nominal,
          structural: desc.structural,
          traits: desc.traits ? [...desc.traits] : undefined,
        });
      case "fixed-array":
        return cacheTypeDesc(typeId, { kind: "fixed-array", element: desc.element });
      default: {
        const _exhaustive: never = desc;
        return _exhaustive;
      }
    }
  };

  const cacheTypeDesc = (typeId: TypeId, value: CodegenTypeDesc): CodegenTypeDesc => {
    typeDescCache.set(typeId, value);
    return value;
  };

  const toCodegenConstraintSet = (constraints: ConstraintSet): CodegenConstraintSet => ({
    traits: constraints.traits ? [...constraints.traits] : undefined,
    structural: constraints.structural
      ? constraints.structural.map((pred) => ({ field: pred.field, type: pred.type }))
      : undefined,
  });

  const toCodegenScheme = (scheme: TypeScheme): CodegenTypeScheme => {
    const cached = schemeCache.get(scheme.id);
    if (cached) {
      return cached;
    }
    const value: CodegenTypeScheme = {
      id: scheme.id,
      params: [...scheme.params],
      body: scheme.body,
      constraints: scheme.constraints ? toCodegenConstraintSet(scheme.constraints) : undefined,
    };
    schemeCache.set(scheme.id, value);
    return value;
  };

  const toCodegenUnificationResult = (
    result: UnificationResult
  ): CodegenUnificationResult =>
    result.ok
      ? { ok: true, substitution: new Map(result.substitution) }
      : {
          ok: false,
          conflict: {
            left: result.conflict.left,
            right: result.conflict.right,
            message: result.conflict.message,
          },
        };

  const toCodegenTraitMethodImpl = ({
    traitSymbol,
    traitMethodSymbol,
  }: {
    traitSymbol: ProgramSymbolId;
    traitMethodSymbol: ProgramSymbolId;
  }): CodegenTraitMethodImpl => ({
    traitSymbol,
    traitMethodSymbol,
  });

  const toCodegenTraitImplInstance = ({
    impl,
    traitSymbol,
    implSymbol,
    methods,
  }: {
    impl: TraitImplInstance;
    traitSymbol: ProgramSymbolId;
    implSymbol: ProgramSymbolId;
    methods: readonly { traitMethod: ProgramSymbolId; implMethod: ProgramSymbolId }[];
  }): CodegenTraitImplInstance => {
    const cacheKey = `${implSymbol}:${impl.trait}:${impl.target}`;
    const cached = traitImplCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const value: CodegenTraitImplInstance = {
      trait: impl.trait,
      traitSymbol,
      target: impl.target,
      methods,
      implSymbol,
    };
    traitImplCache.set(cacheKey, value);
    return value;
  };

  const toCodegenObjectTemplate = ({
    template,
    symbol,
  }: {
    template: ObjectTemplate;
    symbol: ProgramSymbolId;
  }): CodegenObjectTemplate => ({
    symbol,
    params: template.params.map((param) => ({
      symbol: param.symbol,
      typeParam: param.typeParam,
      constraint: param.constraint,
    })),
    nominal: template.nominal,
    structural: template.structural,
    type: template.type,
    fields: template.fields.map(toCodegenStructuralField),
    visibility: template.visibility,
    baseNominal: template.baseNominal,
  });

  const toCodegenObjectTypeInfo = ({
    info,
    traitImpls,
  }: {
    info: ObjectTypeInfo;
    traitImpls?: readonly CodegenTraitImplInstance[];
  }): CodegenObjectTypeInfo => ({
    nominal: info.nominal,
    structural: info.structural,
    type: info.type,
    fields: info.fields.map(toCodegenStructuralField),
    visibility: info.visibility,
    baseNominal: info.baseNominal,
    traitImpls,
  });

  const getOrCreateMap = <K, V>(map: Map<K, V>, key: K, create: () => V): V => {
    const existing = map.get(key);
    if (existing) {
      return existing;
    }
    const next = create();
    map.set(key, next);
    return next;
  };

  stableModules.forEach((mod) => {
    const importsByLocal = new Map<SymbolId, SymbolRef>();
    mod.binding.imports.forEach((imp) => {
      if (!imp.target) return;
      const target = { moduleId: imp.target.moduleId, symbol: imp.target.symbol };
      importsByLocal.set(imp.local, target);
    });
    getSymbolTable(mod)
      .snapshot()
      .symbols.forEach((symbol) => {
        const metadata = (symbol.metadata ?? {}) as {
          import?: { moduleId?: unknown; symbol?: unknown };
        };
        const importModuleId = metadata.import?.moduleId;
        const importSymbol = metadata.import?.symbol;
        if (
          typeof importModuleId === "string" &&
          typeof importSymbol === "number"
        ) {
          importsByLocal.set(symbol.id, {
            moduleId: importModuleId,
            symbol: importSymbol,
          });
        }
      });

    importTargetsByModule.set(mod.moduleId, importsByLocal);

    moduleMetaById.set(mod.moduleId, {
      moduleId: mod.moduleId,
      packageId: mod.binding.packageId,
      isPackageRoot: mod.binding.isPackageRoot,
      imports: mod.binding.imports.map((imp) => ({
        local: imp.local,
      })),
      effects: mod.binding.effects.map((effect) => ({
        name: effect.name,
        effectId: effect.effectId,
        visibility: effect.visibility,
        symbol: effect.symbol,
        operations: effect.operations.map((op) => ({
          name: op.name,
          resumable: op.resumable,
          symbol: op.symbol,
        })),
      })),
    });

	    const callSource = moduleTyping.get(mod.moduleId);
    const callTargets = callSource?.callTargets ?? mod.typing.callTargets;
    const callTypeArgs = callSource?.callTypeArguments ?? mod.typing.callTypeArguments;
    callsByModuleRaw.set(mod.moduleId, {
      targets: cloneNestedMap(callTargets),
      typeArgs: cloneNestedMap(callTypeArgs),
      traitDispatches: new Set(
        callSource?.callTraitDispatches ?? mod.typing.callTraitDispatches
      ),
    });

    // Instances come from the explicit monomorphization pass when available.
  });

  const resolveImportTarget = (ref: SymbolRef): SymbolRef | undefined =>
    importTargetsByModule.get(ref.moduleId)?.get(ref.symbol);

  // Resolve through imports so imported symbols share a single canonical identity.
  const canonicalSymbolRef = createCanonicalSymbolRefResolver({ resolveImportTarget });

  stableModules.forEach((mod) => {
    const targets = importTargetsByModule.get(mod.moduleId);
    if (!targets) return;
    const targetIdsByLocal = new Map<SymbolId, ProgramSymbolId>();
    const localsByTargetId = new Map<ProgramSymbolId, SymbolId>();

    targets.forEach((target, local) => {
      const canonicalTarget = canonicalSymbolRef(target);
      const targetId = symbols.idOf(canonicalTarget);
      targetIdsByLocal.set(local, targetId);
      if (!localsByTargetId.has(targetId)) {
        localsByTargetId.set(targetId, local);
      }
    });

    importTargetIdsByModule.set(mod.moduleId, targetIdsByLocal);
    importLocalsByModule.set(mod.moduleId, localsByTargetId);
  });

  const getProgramFunctionId = (ref: SymbolRef): ProgramFunctionId | undefined =>
    symbols.tryIdOf(canonicalSymbolRef(ref));

  const programSymbolIdOf = (moduleId: string, symbol: SymbolId): ProgramSymbolId =>
    symbols.idOf({ moduleId, symbol });

  const canonicalProgramSymbolIdOf = (
    moduleId: string,
    symbol: SymbolId
  ): ProgramSymbolId => symbols.idOf(canonicalSymbolRef({ moduleId, symbol }));

  const toCodegenTraitImplInstanceForModule = (
    impl: TraitImplInstance,
    moduleId: string
  ): CodegenTraitImplInstance => {
    const traitSymbol = canonicalProgramSymbolIdOf(moduleId, impl.traitSymbol);
    const implSymbol = canonicalProgramSymbolIdOf(moduleId, impl.implSymbol);
    const methods = Array.from(impl.methods.entries())
      .sort(([a], [b]) => a - b)
      .map(([traitMethod, implMethod]) => ({
        traitMethod: canonicalProgramSymbolIdOf(moduleId, traitMethod),
        implMethod: canonicalProgramSymbolIdOf(moduleId, implMethod),
    }));
    return toCodegenTraitImplInstance({ impl, traitSymbol, implSymbol, methods });
  };

  const toCodegenTraitImplTemplateForModule = ({
    template,
    moduleId,
  }: {
    template: {
      trait: TypeId;
      traitSymbol: SymbolId;
      target: TypeId;
      methods: ReadonlyMap<SymbolId, SymbolId>;
      implSymbol: SymbolId;
    };
    moduleId: string;
  }): CodegenTraitImplTemplate => ({
    trait: template.trait,
    traitSymbol: canonicalProgramSymbolIdOf(moduleId, template.traitSymbol),
    target: template.target,
    methods: Array.from(template.methods.entries())
      .sort(([a], [b]) => a - b)
      .map(([traitMethod, implMethod]) => ({
        traitMethod: canonicalProgramSymbolIdOf(moduleId, traitMethod),
        implMethod: canonicalProgramSymbolIdOf(moduleId, implMethod),
      })),
    implSymbol: canonicalProgramSymbolIdOf(moduleId, template.implSymbol),
  });

  stableModules.forEach((mod) => {
    for (const template of mod.typing.objects.templates()) {
      const ownerId = canonicalProgramSymbolIdOf(mod.moduleId, template.symbol);
      if (!objectTemplateByOwner.has(ownerId)) {
        objectTemplateByOwner.set(
          ownerId,
          toCodegenObjectTemplate({ template, symbol: ownerId })
        );
      }
    }

    mod.typing.objectsByNominal.forEach((info, nominal) => {
      const desc = arena.get(nominal);
      if (desc.kind !== "nominal-object") {
        return;
      }

      const ownerRef = toSymbolRef(desc.owner);
      const ownerId = symbols.idOf(canonicalSymbolRef(ownerRef));
      nominalOwnerByNominal.set(nominal, ownerId);

      const bucket = nominalsByOwner.get(ownerId) ?? [];
      bucket.push(nominal);
      nominalsByOwner.set(ownerId, bucket);

      objectInfoByNominal.set(
        nominal,
        toCodegenObjectTypeInfo({
          info,
          traitImpls: info.traitImpls?.map((impl) =>
            toCodegenTraitImplInstanceForModule(impl, mod.moduleId)
          ),
        })
      );
    });

    mod.typing.traitImplsByNominal.forEach((impls, nominal) => {
      const bucket = traitImplsByNominal.get(nominal) ?? [];
      bucket.push(...impls.map((impl) => toCodegenTraitImplInstanceForModule(impl, mod.moduleId)));
      traitImplsByNominal.set(nominal, bucket);
    });

    mod.typing.traitImplsByTrait.forEach((impls, traitSymbol) => {
      const traitSymbolId = canonicalProgramSymbolIdOf(mod.moduleId, traitSymbol);
      const bucket = traitImplsByTrait.get(traitSymbolId) ?? [];
      bucket.push(...impls.map((impl) => toCodegenTraitImplInstanceForModule(impl, mod.moduleId)));
      traitImplsByTrait.set(traitSymbolId, bucket);
    });

    mod.typing.traits.getImplTemplates().forEach((template) => {
      traitImplTemplates.push(
        toCodegenTraitImplTemplateForModule({
          template,
          moduleId: mod.moduleId,
        }),
      );
    });

    mod.typing.traitMethodImpls.forEach((info, symbol) => {
      const key = programSymbolIdOf(mod.moduleId, symbol);
      traitMethodImpls.set(
        key,
        toCodegenTraitMethodImpl({
          traitSymbol: canonicalProgramSymbolIdOf(mod.moduleId, info.traitSymbol),
          traitMethodSymbol: canonicalProgramSymbolIdOf(mod.moduleId, info.traitMethodSymbol),
        })
      );
    });
  });

  const recordInstanceKey = (moduleId: string, key: string): void => {
    const normalized = normalizeCallerInstanceKey(key);
    const parsed = parseFunctionInstanceKey(normalized);
    if (!parsed) return;
    const functionId = getProgramFunctionId({ moduleId, symbol: parsed.symbol });
    if (functionId === undefined) return;
    recordInstantiation(functionId, parsed.typeArgs);
  };

	  stableModules.forEach((mod) => {
	    const instantiationSources = [
	      moduleTyping.get(mod.moduleId)?.functionInstantiationInfo,
	      mod.typing.functionInstantiationInfo,
	    ];
    instantiationSources.forEach((info) => {
      info?.forEach((instantiations, refKey) => {
        const parsed = parseSymbolRefKey(refKey);
        if (!parsed) {
          return;
        }
        const functionId = getProgramFunctionId(parsed);
        if (functionId === undefined) {
          return;
        }
        const calleeModule = modulesById.get(parsed.moduleId);
        const signature = calleeModule?.typing.functions.getSignature(parsed.symbol);
        const expectedTypeParams = signature?.typeParams?.length ?? 0;
        instantiations.forEach((typeArgs) => {
          if (typeArgs.length !== expectedTypeParams) {
            return;
          }
          recordInstantiation(functionId, typeArgs);
        });
      });
    });

    const functionSymbols = Array.from(mod.typing.functions.signatures, ([symbol]) => symbol).sort(
      (a, b) => a - b
    );
    functionSymbols.forEach((symbol) => {
      const signature = mod.typing.functions.getSignature(symbol);
      const typeParamCount = signature?.typeParams?.length ?? 0;
      const functionId = getProgramFunctionId({ moduleId: mod.moduleId, symbol });
      if (functionId === undefined) {
        return;
      }
      if (typeParamCount === 0) {
        recordInstantiation(functionId, []);
      }
    });

    const instanceExprSources = [
      moduleTyping.get(mod.moduleId)?.functionInstanceExprTypes,
      mod.typing.functionInstanceExprTypes,
    ];
    instanceExprSources.forEach((instanceExprTypes) => {
      instanceExprTypes?.forEach((_exprTypes, instanceKey) => {
        recordInstanceKey(mod.moduleId, instanceKey);
      });
    });

    const callTargetsSources = [
      moduleTyping.get(mod.moduleId)?.callTargets,
      mod.typing.callTargets,
    ];
	    callTargetsSources.forEach((callTargets) => {
	      callTargets?.forEach((targets) => {
	        targets.forEach((_targetSymbol, instanceKey) => {
	          recordInstanceKey(mod.moduleId, instanceKey);
	        });
	      });
	    });
	  });

  (options?.instances ?? []).forEach((instance) => {
    const functionId = getProgramFunctionId(instance.callee);
    if (functionId === undefined) {
      return;
    }
    const ref = symbols.refOf(functionId);
    const signature = modulesById.get(ref.moduleId)?.typing.functions.getSignature(ref.symbol);
    const expectedTypeParams = signature?.typeParams?.length ?? 0;
    if (expectedTypeParams !== instance.typeArgs.length) {
      return;
    }
    recordInstantiation(functionId, instance.typeArgs);
  });

	  const getInstanceIdForFunctionAndArgs = (
	    functionId: ProgramFunctionId,
	    typeArgs: readonly TypeId[]
	  ): ProgramFunctionInstanceId | undefined =>
	    instanceIdsByFunctionId.get(functionId)?.get(typeArgs.join(","));

  const getProgramFunctionInstanceId = (
    ref: SymbolRef,
    typeArgs: readonly TypeId[]
  ): ProgramFunctionInstanceId | undefined => {
    const functionId = getProgramFunctionId(ref);
    if (functionId === undefined) {
      return undefined;
    }
    return getInstanceIdForFunctionAndArgs(functionId, typeArgs);
  };

  let nextInstanceId = 0;
  const stableFunctionIds = Array.from(instantiationsByFunctionId.keys()).sort((a, b) => a - b);
  stableFunctionIds.forEach((functionId) => {
    const ref = symbols.refOf(functionId);
    const instantiations = instantiationsByFunctionId.get(functionId);
    if (!instantiations || instantiations.size === 0) {
      return;
    }
    const sorted = Array.from(instantiations.values()).sort(compareTypeArgs);
    const idsByArgs = getOrCreateMap(
      instanceIdsByFunctionId,
      functionId,
      () => new Map<string, ProgramFunctionInstanceId>()
    );
    const instantiationInfo = getOrCreateMap(
      instantiationInfoByFunctionId,
      functionId,
      () => new Map<ProgramFunctionInstanceId, readonly TypeId[]>()
    );
    sorted.forEach((typeArgs) => {
      const instanceId = nextInstanceId as ProgramFunctionInstanceId;
      nextInstanceId += 1;
      idsByArgs.set(typeArgs.join(","), instanceId);
      instantiationInfo.set(instanceId, typeArgs);
      instanceInfoById[instanceId] = {
        functionId,
        typeArgs,
        symbolRef: ref,
      };
    });
  });

  const instanceExprTypesById = new Map<ProgramFunctionInstanceId, Map<HirExprId, TypeId>>();
  const instanceValueTypesById = new Map<ProgramFunctionInstanceId, Map<SymbolId, TypeId>>();

  stableModules.forEach((mod) => {
    const instanceExprSources = [
      moduleTyping.get(mod.moduleId)?.functionInstanceExprTypes,
      mod.typing.functionInstanceExprTypes,
    ];
    instanceExprSources.forEach((instanceExprTypes) => {
      instanceExprTypes?.forEach((exprTypes, instanceKey) => {
        const normalized = normalizeCallerInstanceKey(instanceKey);
        const parsed = parseFunctionInstanceKey(normalized);
        if (!parsed) {
          return;
        }
        const instanceId = getProgramFunctionInstanceId(
          { moduleId: mod.moduleId, symbol: parsed.symbol },
          parsed.typeArgs
        );
        if (instanceId === undefined) {
          return;
        }
        const bucket = instanceExprTypesById.get(instanceId);
        if (!bucket) {
          instanceExprTypesById.set(instanceId, new Map(exprTypes));
          return;
        }
        exprTypes.forEach((typeId, exprId) => {
          if (!bucket.has(exprId)) {
            bucket.set(exprId, typeId);
          }
        });
      });
    });
  });

  stableModules.forEach((mod) => {
    const instanceValueSources = [
      moduleTyping.get(mod.moduleId)?.functionInstanceValueTypes,
      mod.typing.functionInstanceValueTypes,
    ];
    instanceValueSources.forEach((instanceValueTypes) => {
      instanceValueTypes?.forEach((valueTypes, instanceKey) => {
        const normalized = normalizeCallerInstanceKey(instanceKey);
        const parsed = parseFunctionInstanceKey(normalized);
        if (!parsed) {
          return;
        }
        const instanceId = getProgramFunctionInstanceId(
          { moduleId: mod.moduleId, symbol: parsed.symbol },
          parsed.typeArgs
        );
        if (instanceId === undefined) {
          return;
        }
        const bucket = instanceValueTypesById.get(instanceId);
        if (!bucket) {
          instanceValueTypesById.set(instanceId, new Map(valueTypes));
          return;
        }
        valueTypes.forEach((typeId, symbol) => {
          if (!bucket.has(symbol)) {
            bucket.set(symbol, typeId);
          }
        });
      });
    });
  });

  const getCallerInstanceId = (
    moduleId: string,
    key: string
  ): ProgramFunctionInstanceId | undefined => {
    const normalized = normalizeCallerInstanceKey(key);
    const parsed = parseFunctionInstanceKey(normalized);
    if (!parsed) return undefined;
    return getProgramFunctionInstanceId(
      { moduleId, symbol: parsed.symbol },
      parsed.typeArgs
    );
  };

	  callsByModuleRaw.forEach((data, moduleId) => {
	    const mappedTargets = new Map<
	      HirExprId,
	      ReadonlyMap<ProgramFunctionInstanceId, ProgramFunctionId>
	    >();
	    data.targets.forEach((targets, exprId) => {
	      const mapped = new Map<ProgramFunctionInstanceId, ProgramFunctionId>();
	      targets.forEach((targetRef, instanceKey) => {
	        const callerInstanceId = getCallerInstanceId(moduleId, instanceKey);
	        const targetFunctionId = getProgramFunctionId(toSymbolRef(targetRef));
	        if (callerInstanceId === undefined || targetFunctionId === undefined) {
	          return;
	        }
	        mapped.set(callerInstanceId, targetFunctionId);
	      });
	      mappedTargets.set(exprId, mapped);
	    });

	    const mappedTypeArgs = new Map<
	      HirExprId,
	      ReadonlyMap<ProgramFunctionInstanceId, readonly TypeId[]>
	    >();
	    data.typeArgs.forEach((argsByInstanceKey, exprId) => {
	      const mapped = new Map<ProgramFunctionInstanceId, readonly TypeId[]>();
	      argsByInstanceKey.forEach((typeArgs, instanceKey) => {
	        const callerInstanceId = getCallerInstanceId(moduleId, instanceKey);
	        if (callerInstanceId === undefined) {
	          return;
	        }
	        mapped.set(callerInstanceId, typeArgs);
	      });
	      mappedTypeArgs.set(exprId, mapped);
	    });

	    callsByModule.set(moduleId, {
	      targets: mappedTargets,
	      typeArgs: mappedTypeArgs,
	      traitDispatches: new Set(data.traitDispatches),
	    });
	  });

  (options?.instances ?? []).forEach((info) => {
    const functionId = getProgramFunctionId(info.callee);
    if (functionId === undefined) {
      return;
    }
    const instanceId = getInstanceIdForFunctionAndArgs(functionId, info.typeArgs);
    if (instanceId === undefined) {
      return;
    }
    const data: MonomorphizedInstanceInfo = {
      callee: functionId,
      typeArgs: info.typeArgs,
      instanceId,
    };
    allInstances.push(data);
    instanceById.set(instanceId, data);
  });

  nominalsByOwner.forEach((bucket, owner) => {
    bucket.sort((a, b) => a - b);
    nominalsByOwner.set(owner, bucket);
  });

  traitImplsByNominal.forEach((bucket, nominal) => {
    bucket.sort((a, b) => a.implSymbol - b.implSymbol);
    const seen = new Set<ProgramSymbolId>();
    const unique = bucket.filter((impl) => {
      if (seen.has(impl.implSymbol)) return false;
      seen.add(impl.implSymbol);
      return true;
    });
    traitImplsByNominal.set(nominal, unique);
  });

  traitImplsByTrait.forEach((bucket, symbol) => {
    bucket.sort((a, b) => a.implSymbol - b.implSymbol);
    const seen = new Set<ProgramSymbolId>();
    const unique = bucket.filter((impl) => {
      if (seen.has(impl.implSymbol)) return false;
      seen.add(impl.implSymbol);
      return true;
    });
    traitImplsByTrait.set(symbol, unique);
  });

  traitImplTemplates.sort((a, b) => a.implSymbol - b.implSymbol);
  const seenTraitImplTemplates = new Set<ProgramSymbolId>();
  const uniqueTraitImplTemplates = traitImplTemplates.filter((template) => {
    if (seenTraitImplTemplates.has(template.implSymbol)) return false;
    seenTraitImplTemplates.add(template.implSymbol);
    return true;
  });

  allInstances.sort((a, b) => a.instanceId - b.instanceId);

  const types: TypeLoweringIndex = {
    getTypeDesc: (typeId) => toCodegenTypeDesc(typeId, arena.get(typeId)),
    getScheme: (schemeId) => toCodegenScheme(arena.getScheme(schemeId)),
    instantiate: (schemeId, args, ctx) =>
      arena.instantiate(schemeId, args, ctx as UnificationContext | undefined),
    unify: (a, b, ctx) =>
      toCodegenUnificationResult(arena.unify(a, b, ctx as UnificationContext)),
    substitute: (typeId, subst) => arena.substitute(typeId, subst),
    getNominalOwner: (typeId) => {
      const desc = arena.get(typeId);
      return desc.kind === "nominal-object" ? symbols.idOf(toSymbolRef(desc.owner)) : undefined;
    },
    getNominalAncestry: (typeId) => {
      const seen = new Set<TypeId>();
      const ancestry: { nominalId: TypeId; typeId: TypeId }[] = [];
      let current: TypeId | undefined = typeId;
      while (typeof current === "number" && !seen.has(current)) {
        seen.add(current);
        const desc = arena.get(current);
        if (desc.kind !== "nominal-object") {
          break;
        }
        const info = objectInfoByNominal.get(current);
        ancestry.push({ nominalId: current, typeId: info?.type ?? current });
        current = info?.baseNominal;
      }
      return ancestry;
    },
    getStructuralLayout: (typeId) => {
      const desc = arena.get(typeId);
      if (desc.kind === "structural-object") {
        return {
          kind: "structural-object",
          fields: desc.fields.map((field) => ({
            name: field.name,
            typeId: field.type,
            optional: field.optional === true,
          })),
        };
      }
      if (desc.kind === "fixed-array") {
        return { kind: "fixed-array", element: desc.element };
      }
      if (desc.kind === "function") {
        return {
          kind: "function",
          params: desc.parameters.map((param) => param.type),
          result: desc.returnType,
        };
      }
      if (desc.kind === "primitive") {
        return { kind: "primitive", name: desc.name };
      }
      return { kind: "other", kindName: desc.kind };
    },
    getRuntimeTypeId: (typeId) => typeId,
    getAliasSymbols: (typeId) => {
      const symbolsForType = aliasSymbolsByType.get(typeId);
      return symbolsForType ? Array.from(symbolsForType).sort((a, b) => a - b) : [];
    },
  };

  const optionals = {
    getOptionalInfo: (moduleId: string, typeId: TypeId): CodegenOptionalInfo | undefined => {
      const ctx: OptionalResolverContext = {
        arena,
        unknownType: first.typing.primitives.unknown,
        getObjectStructuralTypeId: (nominal) => objectInfoByNominal.get(nominal)?.structural,
        getSymbolIntrinsicType: (symbol) =>
          symbols.getIntrinsicType(canonicalProgramSymbolIdOf(moduleId, symbol)),
      };
      const info = getOptionalInfo(typeId, ctx);
      return info
        ? {
            optionalType: info.optionalType,
            innerType: info.innerType,
            someType: info.someType,
            noneType: info.noneType,
          }
        : undefined;
    },
  };

  const objects: ObjectLayoutIndex = {
    getTemplate: (owner) => objectTemplateByOwner.get(owner),
    getInfoByNominal: (nominal) => objectInfoByNominal.get(nominal),
    getNominalOwnerRef: (nominal) => nominalOwnerByNominal.get(nominal),
    getNominalInstancesByOwner: (owner) => nominalsByOwner.get(owner) ?? [],
  };

  const traits: TraitDispatchIndex = {
    getImplsByNominal: (nominal) => traitImplsByNominal.get(nominal) ?? [],
    getImplsByTrait: (traitSymbol) => traitImplsByTrait.get(traitSymbol) ?? [],
    getImplTemplates: () => uniqueTraitImplTemplates,
    getTraitMethodImpl: (symbol) => traitMethodImpls.get(symbol),
  };

  const calls: CallLoweringIndex = {
    getCallInfo: (moduleId, expr) => {
      const data = callsByModule.get(moduleId);
      if (!data) {
        return { traitDispatch: false };
      }
      return {
        targets: data.targets.get(expr),
        typeArgs: data.typeArgs.get(expr),
        traitDispatch: data.traitDispatches.has(expr),
      };
    },
  };

  const functions: FunctionLoweringIndex = {
    getSignature: (moduleId, symbol) => {
      const mod = modulesById.get(moduleId);
      const signature = mod?.typing.functions.getSignature(symbol);
      if (!mod || !signature) return undefined;
      return {
        typeId: signature.typeId,
        scheme: signature.scheme,
        parameters: signature.parameters.map((param) => ({
          typeId: param.type,
          label: param.label,
          optional: param.optional === true,
          name: param.name,
          symbol: param.symbol,
        })),
        returnType: signature.returnType,
        effectRow: signature.effectRow,
        typeParams: (signature.typeParams ?? []).map((param) => ({
          symbol: param.symbol,
          typeParam: param.typeParam,
          typeRef: param.typeRef,
          constraint: param.constraint,
        })),
      };
    },
    getInstantiationInfo: (moduleId, symbol) => {
      const functionId = getProgramFunctionId({ moduleId, symbol });
      return typeof functionId === "number"
        ? instantiationInfoByFunctionId.get(functionId)
        : undefined;
    },
    getInstanceExprType: (instanceId, expr) =>
      instanceExprTypesById.get(instanceId)?.get(expr),
    getInstanceValueType: (instanceId, symbol) =>
      instanceValueTypesById.get(instanceId)?.get(symbol),
    getFunctionId: (ref) => getProgramFunctionId(ref),
    getInstanceId: (moduleId, symbol, typeArgs) => {
      if (!typeArgs) return undefined;
      return getProgramFunctionInstanceId({ moduleId, symbol }, typeArgs);
    },
    getFunctionRef: (functionId) => {
      try {
        return symbols.refOf(functionId);
      } catch {
        return undefined;
      }
    },
    getInstance: (instanceId) => {
      const info = instanceInfoById[instanceId];
      if (!info) {
        throw new Error(`unknown function instance ${instanceId}`);
      }
      return {
        functionId: info.functionId,
        typeArgs: info.typeArgs,
        symbolRef: info.symbolRef,
      };
    },
    formatInstance: (instanceId) => {
      const info = instanceInfoById[instanceId];
      if (!info) {
        return `instance${instanceId}`;
      }
      const name = symbols.getName(info.functionId) ?? `${info.symbolRef.symbol}`;
      const args = info.typeArgs.length === 0 ? "" : info.typeArgs.join(",");
      return `${info.symbolRef.moduleId}::${name}<${args}>`;
    },
  };

  const instances: MonomorphizedInstanceIndex = {
    getAll: () => allInstances,
    getById: (instanceId) => instanceById.get(instanceId),
  };

  const effectGlobalIdsByModule = new Map<string, number[]>();
  const effectByGlobalId: { moduleId: string; localEffectIndex: number }[] = [];

  stableModules.forEach((mod) => {
    const meta = moduleMetaById.get(mod.moduleId);
    if (!meta) return;
    const ids = effectGlobalIdsByModule.get(mod.moduleId) ?? [];
    meta.effects.forEach((_effect, localEffectIndex) => {
      const effectId = effectByGlobalId.length;
      effectByGlobalId.push({ moduleId: mod.moduleId, localEffectIndex });
      ids[localEffectIndex] = effectId;
    });
    effectGlobalIdsByModule.set(mod.moduleId, ids);
  });

  const effects: EffectInterner & ProgramEffectIndex = {
    ...effectsInterner,
    getOrderedModules: () => stableModules.map((mod) => mod.moduleId),
    getGlobalId: (moduleId, localEffectIndex) =>
      effectGlobalIdsByModule.get(moduleId)?.[localEffectIndex],
    getByGlobalId: (effectId) => effectByGlobalId[effectId],
    getEffectCount: () => effectByGlobalId.length,
  };

  const imports: ImportWiringIndex = {
    getLocal: (moduleId, target) => importLocalsByModule.get(moduleId)?.get(target),
    getTarget: (moduleId, local) => importTargetIdsByModule.get(moduleId)?.get(local),
  };

  const moduleViews = new Map<string, ModuleCodegenView>();
  stableModules.forEach((mod) => {
    const meta = moduleMetaById.get(mod.moduleId);
    if (!meta) return;
    moduleViews.set(mod.moduleId, {
      moduleId: mod.moduleId,
      meta,
      hir: mod.hir,
      effects: mod.typing.effects,
      types: {
        getExprType: (expr) =>
          mod.typing.table.getExprType(expr) ?? first.typing.primitives.unknown,
        getResolvedExprType: (expr) => mod.typing.resolvedExprTypes.get(expr),
        getValueType: (symbol) =>
          mod.typing.valueTypes.get(symbol) ??
          moduleTyping.get(mod.moduleId)?.valueTypes.get(symbol),
        getTailResumption: (expr) => mod.typing.tailResumptions.get(expr),
      },
      effectsInfo: buildEffectsLoweringInfo({
        binding: mod.binding,
        symbolTable: getSymbolTable(mod),
        hir: mod.hir,
        typing: mod.typing,
      }),
    });
  });

  return {
    effects,
    primitives: {
      bool: first.typing.primitives.bool,
      void: first.typing.primitives.void,
      unknown: first.typing.primitives.unknown,
      defaultEffectRow: first.typing.primitives.defaultEffectRow,
      i32: first.typing.primitives.i32,
      i64: first.typing.primitives.i64,
      f32: first.typing.primitives.f32,
      f64: first.typing.primitives.f64,
    },
    types,
    symbols: {
      ...symbols,
      canonicalIdOf: canonicalProgramSymbolIdOf,
    },
    functions,
    optionals,
    objects,
    traits,
    calls,
    instances,
    imports,
    modules: moduleViews,
  };
};
