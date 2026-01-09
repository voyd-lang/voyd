import type { HirGraph, HirEffectHandlerClause, HirVisibility } from "../hir/index.js";
import type { EffectInterner } from "../effects/effect-table.js";
import type { EffectTable } from "../effects/effect-table.js";
import type {
  HirExprId,
  NodeId,
  SymbolId,
  TypeId,
  TypeParamId,
  TypeSchemeId,
} from "../ids.js";
import type {
  ConstraintSet,
  StructuralField,
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
  TraitImplInstance,
  TraitMethodImpl,
} from "../typing/types.js";
import {
  getOptionalInfo,
  type OptionalResolverContext,
} from "../typing/optionals.js";

export type SymbolRef = {
  moduleId: string;
  symbol: SymbolId;
};

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
  | { kind: "trait"; owner: SymbolRef; name?: string; typeArgs: readonly TypeId[] }
  | { kind: "nominal-object"; owner: SymbolRef; name?: string; typeArgs: readonly TypeId[] }
  | { kind: "structural-object"; fields: readonly CodegenStructuralField[] }
  | { kind: "function"; parameters: readonly CodegenFunctionParameter[]; returnType: TypeId; effectRow: number }
  | { kind: "union"; members: readonly TypeId[] }
  | { kind: "intersection"; nominal?: TypeId; structural?: TypeId }
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
  targets?: ReadonlyMap<string, SymbolId>;
  typeArgs?: readonly TypeId[];
  instanceKey?: string;
  traitDispatch: boolean;
};

export type InstanceKey = string & { readonly __brand: "InstanceKey" };

export const makeInstanceKey = (moduleId: string, localKey: string): InstanceKey =>
  `${moduleId}::${localKey}` as InstanceKey;

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
  ): ReadonlyMap<string, readonly TypeId[]> | undefined;
  getInstanceExprType(moduleId: string, key: string, expr: HirExprId): TypeId | undefined;
};

export type ModuleTypeIndex = {
  getExprType(expr: HirExprId): TypeId;
  getResolvedExprType(expr: HirExprId): TypeId | undefined;
  getValueType(symbol: SymbolId): TypeId | undefined;
  getTailResumption(expr: HirExprId): HirEffectHandlerClause["tailResumption"] | undefined;
};

export type MonomorphizedInstanceInfo = {
  callee: SymbolRef;
  typeArgs: readonly TypeId[];
  instanceKey: InstanceKey;
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
  getNominalOwner(typeId: TypeId): SymbolRef | undefined;
  getNominalAncestry(typeId: TypeId): readonly { nominalId: TypeId; typeId: TypeId }[];
  getStructuralLayout(typeId: TypeId): StructuralLayout | undefined;
  getRuntimeTypeId(typeId: TypeId): number;
};

export type SymbolIndex = {
  getName(ref: SymbolRef): string | undefined;
  getLocalName(moduleId: string, symbol: SymbolId): string | undefined;
  getPackageId(moduleId: string): string | undefined;
  getIntrinsicType(moduleId: string, symbol: SymbolId): string | undefined;
  getIntrinsicFunctionFlags(
    moduleId: string,
    symbol: SymbolId
  ): { intrinsic: boolean; intrinsicUsesSignature: boolean };
  getIntrinsicName(moduleId: string, symbol: SymbolId): string | undefined;
  isModuleScoped(moduleId: string, symbol: SymbolId): boolean;
};

export type ObjectLayoutIndex = {
  getTemplate(owner: SymbolRef): CodegenObjectTemplate | undefined;
  getInfoByNominal(nominal: TypeId): CodegenObjectTypeInfo | undefined;
  getNominalOwnerRef(nominal: TypeId): SymbolRef | undefined;
  getNominalInstancesByOwner(owner: SymbolRef): readonly TypeId[];
};

export type TraitDispatchIndex = {
  getImplsByNominal(nominal: TypeId): readonly CodegenTraitImplInstance[];
  getImplsByTrait(traitSymbol: SymbolId): readonly CodegenTraitImplInstance[];
  getTraitMethodImpl(symbol: SymbolId): CodegenTraitMethodImpl | undefined;
};

export type CallLoweringIndex = {
  getCallInfo(moduleId: string, expr: HirExprId): CallLoweringInfo;
};

export type MonomorphizedInstanceIndex = {
  getAll(): readonly MonomorphizedInstanceInfo[];
  getByKey(instanceKey: InstanceKey): MonomorphizedInstanceInfo | undefined;
};

export type ModuleCodegenMetadata = {
  moduleId: string;
  packageId: string;
  isPackageRoot: boolean;
  imports: readonly {
    local: SymbolId;
    target?: { moduleId: string; symbol: SymbolId };
  }[];
  effects: readonly {
    name: string;
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
  getLocal(moduleId: string, target: SymbolRef): SymbolId | undefined;
  getTarget(moduleId: string, local: SymbolId): SymbolRef | undefined;
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
  symbols: SymbolIndex;
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
  symbol: SymbolId;
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
  traitSymbol: SymbolId;
  traitMethodSymbol: SymbolId;
};

export type CodegenTraitImplInstance = {
  trait: TypeId;
  traitSymbol: SymbolId;
  target: TypeId;
  methods: readonly { traitMethod: SymbolId; implMethod: SymbolId }[];
  implSymbol: SymbolId;
};

export const buildProgramCodegenView = (
  modules: readonly SemanticsPipelineResult[],
  options?: {
    instances?: readonly MonomorphizedInstanceInfo[];
    moduleTyping?: ReadonlyMap<
      string,
      {
        functionInstantiationInfo: ReadonlyMap<SymbolId, ReadonlyMap<string, readonly TypeId[]>>;
        functionInstanceExprTypes: ReadonlyMap<string, ReadonlyMap<HirExprId, TypeId>>;
        valueTypes: ReadonlyMap<SymbolId, TypeId>;
      }
    >;
  }
): ProgramCodegenView => {
  const modulesById = new Map<string, SemanticsPipelineResult>(
    modules.map((mod) => [mod.moduleId, mod] as const)
  );
  const moduleTyping = options?.moduleTyping ?? new Map();
  const first = modules[0];
  if (!first) {
    throw new Error("buildProgramCodegenView requires at least one module");
  }

  const arena = first.typing.arena;
  const effectsInterner: EffectInterner = first.typing.effects;

  const objectTemplateByOwner = new Map<string, CodegenObjectTemplate>();
  const objectInfoByNominal = new Map<TypeId, CodegenObjectTypeInfo>();
  const nominalOwnerByNominal = new Map<TypeId, SymbolRef>();
  const nominalsByOwner = new Map<string, TypeId[]>();

  const traitImplsByNominal = new Map<TypeId, CodegenTraitImplInstance[]>();
  const traitImplsByTrait = new Map<SymbolId, CodegenTraitImplInstance[]>();
  const traitMethodImpls = new Map<SymbolId, CodegenTraitMethodImpl>();

  const callsByModule = new Map<
    string,
    {
      targets: Map<HirExprId, ReadonlyMap<string, SymbolId>>;
      typeArgs: Map<HirExprId, readonly TypeId[]>;
      instanceKeys: Map<HirExprId, string>;
      traitDispatches: Set<HirExprId>;
    }
  >();

  const allInstances: MonomorphizedInstanceInfo[] = [];
  const instanceByKey = new Map<string, MonomorphizedInstanceInfo>();

  const stableModules = [...modules].sort((a, b) =>
    a.moduleId.localeCompare(b.moduleId, undefined, { numeric: true })
  );

  const moduleMetaById = new Map<string, ModuleCodegenMetadata>();
  const importTargetsByModule = new Map<string, Map<SymbolId, SymbolRef>>();
  const importLocalsByModule = new Map<string, Map<string, SymbolId>>();

  const symbolRefKey = (ref: SymbolRef): string => `${ref.moduleId}::${ref.symbol}`;

  const toSymbolRef = (ref: TypingSymbolRef): SymbolRef => ({
    moduleId: ref.moduleId,
    symbol: ref.symbol,
  });

  const typeDescCache = new Map<TypeId, CodegenTypeDesc>();
  const schemeCache = new Map<TypeSchemeId, CodegenTypeScheme>();
  const traitImplCache = new Map<string, CodegenTraitImplInstance>();

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
      case "type-param-ref":
        return cacheTypeDesc(typeId, { kind: "type-param-ref", param: desc.param });
      case "trait":
        return cacheTypeDesc(typeId, {
          kind: "trait",
          owner: toSymbolRef(desc.owner),
          name: desc.name,
          typeArgs: [...desc.typeArgs],
        });
      case "nominal-object":
        return cacheTypeDesc(typeId, {
          kind: "nominal-object",
          owner: toSymbolRef(desc.owner),
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

  const toCodegenTraitMethodImpl = (info: TraitMethodImpl): CodegenTraitMethodImpl => ({
    traitSymbol: info.traitSymbol,
    traitMethodSymbol: info.traitMethodSymbol,
  });

  const toCodegenTraitImplInstance = (impl: TraitImplInstance): CodegenTraitImplInstance => {
    const cacheKey = `${impl.implSymbol}:${impl.trait}:${impl.target}`;
    const cached = traitImplCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const value: CodegenTraitImplInstance = {
      trait: impl.trait,
      traitSymbol: impl.traitSymbol,
      target: impl.target,
      methods: Array.from(impl.methods.entries())
        .sort(([a], [b]) => a - b)
        .map(([traitMethod, implMethod]) => ({ traitMethod, implMethod })),
      implSymbol: impl.implSymbol,
    };
    traitImplCache.set(cacheKey, value);
    return value;
  };

  const toCodegenObjectTemplate = (template: ObjectTemplate): CodegenObjectTemplate => ({
    symbol: template.symbol,
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

  const toCodegenObjectTypeInfo = (info: ObjectTypeInfo): CodegenObjectTypeInfo => ({
    nominal: info.nominal,
    structural: info.structural,
    type: info.type,
    fields: info.fields.map(toCodegenStructuralField),
    visibility: info.visibility,
    baseNominal: info.baseNominal,
    traitImpls: info.traitImpls?.map(toCodegenTraitImplInstance),
  });

  stableModules.forEach((mod) => {
    const importsByLocal = new Map<SymbolId, SymbolRef>();
    const localsByTarget = new Map<string, SymbolId>();
    mod.binding.imports.forEach((imp) => {
      if (!imp.target) return;
      const target = { moduleId: imp.target.moduleId, symbol: imp.target.symbol };
      importsByLocal.set(imp.local, target);
      const targetKey = symbolRefKey(target);
      if (!localsByTarget.has(targetKey)) {
        localsByTarget.set(targetKey, imp.local);
      }
    });

    importTargetsByModule.set(mod.moduleId, importsByLocal);
    importLocalsByModule.set(mod.moduleId, localsByTarget);

    moduleMetaById.set(mod.moduleId, {
      moduleId: mod.moduleId,
      packageId: mod.binding.packageId,
      isPackageRoot: mod.binding.isPackageRoot,
      imports: mod.binding.imports.map((imp) => ({
        local: imp.local,
        target: imp.target
          ? { moduleId: imp.target.moduleId, symbol: imp.target.symbol }
          : undefined,
      })),
      effects: mod.binding.effects.map((effect) => ({
        name: effect.name,
        operations: effect.operations.map((op) => ({
          name: op.name,
          resumable: op.resumable,
          symbol: op.symbol,
        })),
      })),
    });

    for (const template of mod.typing.objects.templates()) {
      const owner: SymbolRef = { moduleId: mod.moduleId, symbol: template.symbol };
      objectTemplateByOwner.set(symbolRefKey(owner), toCodegenObjectTemplate(template));
    }

    mod.typing.objectsByNominal.forEach((info, nominal) => {
      objectInfoByNominal.set(nominal, toCodegenObjectTypeInfo(info));
      const desc = arena.get(nominal);
      if (desc.kind !== "nominal-object") {
        return;
      }
      nominalOwnerByNominal.set(nominal, toSymbolRef(desc.owner));
      const ownerKey = symbolRefKey(toSymbolRef(desc.owner));
      const bucket = nominalsByOwner.get(ownerKey) ?? [];
      bucket.push(nominal);
      nominalsByOwner.set(ownerKey, bucket);
    });

    const implsByNominal = mod.typing.traitImplsByNominal;
    implsByNominal.forEach((impls, nominal) => {
      const mapped = impls.map(toCodegenTraitImplInstance);
      const bucket = traitImplsByNominal.get(nominal) ?? [];
      bucket.push(...mapped);
      traitImplsByNominal.set(nominal, bucket);
    });

    const implsByTrait = mod.typing.traitImplsByTrait;
    implsByTrait.forEach((impls, traitSymbol) => {
      const mapped = impls.map(toCodegenTraitImplInstance);
      const bucket = traitImplsByTrait.get(traitSymbol) ?? [];
      bucket.push(...mapped);
      traitImplsByTrait.set(traitSymbol, bucket);
    });

    mod.typing.traitMethodImpls.forEach((info, symbol) => {
      traitMethodImpls.set(symbol, toCodegenTraitMethodImpl(info));
    });

    callsByModule.set(mod.moduleId, {
      targets: new Map(
        Array.from(mod.typing.callTargets.entries()).map(([exprId, targets]) => [
          exprId,
          new Map(targets),
        ])
      ),
      typeArgs: new Map(mod.typing.callTypeArguments),
      instanceKeys: new Map(mod.typing.callInstanceKeys),
      traitDispatches: new Set(mod.typing.callTraitDispatches),
    });

    // Instances come from the explicit monomorphization pass when available.
  });

  (options?.instances ?? []).forEach((info) => {
    allInstances.push(info);
    instanceByKey.set(info.instanceKey, info);
  });

  nominalsByOwner.forEach((bucket, ownerKey) => {
    bucket.sort((a, b) => a - b);
    nominalsByOwner.set(ownerKey, bucket);
  });

  traitImplsByNominal.forEach((bucket, nominal) => {
    bucket.sort((a, b) => a.implSymbol - b.implSymbol);
    traitImplsByNominal.set(nominal, bucket);
  });

  traitImplsByTrait.forEach((bucket, symbol) => {
    bucket.sort((a, b) => a.implSymbol - b.implSymbol);
    traitImplsByTrait.set(symbol, bucket);
  });

  allInstances.sort((a, b) => {
    const modOrder = a.callee.moduleId.localeCompare(b.callee.moduleId, undefined, {
      numeric: true,
    });
    if (modOrder !== 0) return modOrder;
    if (a.callee.symbol !== b.callee.symbol) return a.callee.symbol - b.callee.symbol;
    return a.instanceKey.localeCompare(b.instanceKey, undefined, { numeric: true });
  });

  const types: TypeLoweringIndex = {
    getTypeDesc: (typeId) => toCodegenTypeDesc(typeId, arena.get(typeId)),
    getScheme: (schemeId) => toCodegenScheme(arena.getScheme(schemeId)),
    instantiate: (schemeId, args, ctx) =>
      arena.instantiate(schemeId, args, ctx as UnificationContext | undefined),
    unify: (a, b, ctx) =>
      toCodegenUnificationResult(arena.unify(a, b, ctx as UnificationContext)),
    getNominalOwner: (typeId) => {
      const desc = arena.get(typeId);
      return desc.kind === "nominal-object" ? toSymbolRef(desc.owner) : undefined;
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
  };

  const symbols: SymbolIndex = {
    getName: (ref) => {
      const mod = modulesById.get(ref.moduleId);
      return mod?.symbols.getName(ref.symbol);
    },
    getLocalName: (moduleId, symbol) => modulesById.get(moduleId)?.symbols.getName(symbol),
    getPackageId: (moduleId) => moduleMetaById.get(moduleId)?.packageId,
    getIntrinsicType: (moduleId, symbol) =>
      modulesById.get(moduleId)?.symbols.getIntrinsicType(symbol),
    getIntrinsicFunctionFlags: (moduleId, symbol) =>
      modulesById.get(moduleId)?.symbols.getIntrinsicFunctionFlags(symbol) ?? {
        intrinsic: false,
        intrinsicUsesSignature: false,
      },
    getIntrinsicName: (moduleId, symbol) =>
      modulesById.get(moduleId)?.symbols.getIntrinsicName(symbol),
    isModuleScoped: (moduleId, symbol) =>
      modulesById.get(moduleId)?.symbols.isModuleScoped(symbol) ?? false,
  };

  const optionals = {
    getOptionalInfo: (moduleId: string, typeId: TypeId): CodegenOptionalInfo | undefined => {
      const ctx: OptionalResolverContext = {
        arena,
        unknownType: first.typing.primitives.unknown,
        getObjectStructuralTypeId: (nominal) => objectInfoByNominal.get(nominal)?.structural,
        getSymbolIntrinsicType: (symbol) => symbols.getIntrinsicType(moduleId, symbol),
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
    getTemplate: (owner) => objectTemplateByOwner.get(symbolRefKey(owner)),
    getInfoByNominal: (nominal) => objectInfoByNominal.get(nominal),
    getNominalOwnerRef: (nominal) => nominalOwnerByNominal.get(nominal),
    getNominalInstancesByOwner: (owner) =>
      nominalsByOwner.get(symbolRefKey(owner)) ?? [],
  };

  const traits: TraitDispatchIndex = {
    getImplsByNominal: (nominal) => traitImplsByNominal.get(nominal) ?? [],
    getImplsByTrait: (traitSymbol) => traitImplsByTrait.get(traitSymbol) ?? [],
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
        instanceKey: data.instanceKeys.get(expr),
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
    getInstantiationInfo: (moduleId, symbol) =>
      moduleTyping.get(moduleId)?.functionInstantiationInfo.get(symbol) ??
      modulesById.get(moduleId)?.typing.functionInstantiationInfo.get(symbol),
    getInstanceExprType: (moduleId, key, expr) =>
      moduleTyping.get(moduleId)?.functionInstanceExprTypes.get(key)?.get(expr) ??
      modulesById.get(moduleId)?.typing.functionInstanceExprTypes.get(key)?.get(expr),
  };

  const instances: MonomorphizedInstanceIndex = {
    getAll: () => allInstances,
    getByKey: (key) => instanceByKey.get(key),
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
    getLocal: (moduleId, target) =>
      importLocalsByModule.get(moduleId)?.get(symbolRefKey(target)),
    getTarget: (moduleId, local) => importTargetsByModule.get(moduleId)?.get(local),
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
          moduleTyping.get(mod.moduleId)?.valueTypes.get(symbol) ?? mod.typing.valueTypes.get(symbol),
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
    symbols,
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
