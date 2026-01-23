import binaryen from "binaryen";
import {
  binaryenTypeToHeapType,
  defineStructType,
  refFunc,
  refCast,
} from "@voyd/lib/binaryen-gc/index.js";
import { mapPrimitiveToWasm } from "./primitive-types.js";
export { getFunctionRefType } from "./closure-types.js";
import { ensureClosureTypeInfo } from "./closure-types.js";
import {
  ensureFixedArrayWasmTypes,
  ensureFixedArrayWasmTypesByElement,
} from "./fixed-array-types.js";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import { RTT_METADATA_SLOT_COUNT } from "./rtt/index.js";
import { murmurHash3 } from "@voyd/lib/murmur-hash.js";
import type {
  CodegenContext,
  ClosureTypeInfo,
  StructuralFieldInfo,
  StructuralTypeInfo,
  FunctionMetadata,
  HirTypeExpr,
  HirExprId,
  HirPattern,
  SymbolId,
  TypeId,
  FixedArrayWasmType,
} from "./context.js";
import type { MethodAccessorEntry } from "./rtt/method-accessor.js";
import type { CodegenTraitImplInstance } from "../semantics/codegen-view/index.js";
import type {
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  TypeParamId,
} from "../semantics/ids.js";
import { buildInstanceSubstitution } from "./type-substitution.js";

const bin = binaryen as unknown as AugmentedBinaryen;

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

type WasmTypeMode = "runtime" | "signature";

const runtimeTypeKeyFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Map<TypeId, number>,
  recursiveParams: Map<TypeParamId, number>
): string => {
  const seenIndex = seen.get(typeId);
  if (seenIndex !== undefined) {
    return `recursive:${seenIndex}`;
  }
  seen.set(typeId, seen.size);

  const desc = ctx.program.types.getTypeDesc(typeId);
  switch (desc.kind) {
    case "primitive":
      return `prim:${desc.name}`;
    case "recursive":
      if (!recursiveParams.has(desc.binder)) {
        recursiveParams.set(desc.binder, recursiveParams.size);
      }
      return `mu:${runtimeTypeKeyFor(desc.body, ctx, seen, recursiveParams)}`;
    case "type-param-ref":
      if (recursiveParams.has(desc.param)) {
        return `recursive-param:${recursiveParams.get(desc.param)}`;
      }
      return `typeparam:${desc.param}`;
    case "nominal-object":
      return `nominal:${desc.owner}<${desc.typeArgs
        .map((arg) => runtimeTypeKeyFor(arg, ctx, seen, recursiveParams))
        .join(",")}>`;
    case "trait":
      return `trait:${desc.owner}<${desc.typeArgs
        .map((arg) => runtimeTypeKeyFor(arg, ctx, seen, recursiveParams))
        .join(",")}>`;
    case "structural-object":
      return `struct:{${desc.fields
        .map(
          (field) =>
            `${field.name}${field.optional ? "?" : ""}:${runtimeTypeKeyFor(
              field.type,
              ctx,
              seen,
              recursiveParams
            )}`
        )
        .join(",")}}`;
    case "function":
      return `fn:(${desc.parameters
        .map((param) => runtimeTypeKeyFor(param.type, ctx, seen, recursiveParams))
        .join(",")})->${runtimeTypeKeyFor(desc.returnType, ctx, seen, recursiveParams)}`;
    case "union": {
      const members = desc.members
        .map((member) => runtimeTypeKeyFor(member, ctx, seen, recursiveParams))
        .sort();
      return `union:${members.join("|")}`;
    }
    case "intersection": {
      const nominal =
        typeof desc.nominal === "number"
          ? runtimeTypeKeyFor(desc.nominal, ctx, seen, recursiveParams)
          : "none";
      const structural =
        typeof desc.structural === "number"
          ? runtimeTypeKeyFor(desc.structural, ctx, seen, recursiveParams)
          : "none";
      return `intersection:${nominal}&${structural}`;
    }
    case "fixed-array":
      return `fixed-array:${runtimeTypeKeyFor(desc.element, ctx, seen, recursiveParams)}`;
    default:
      return `${(desc as { kind: string }).kind}:${typeId}`;
  }
};

const runtimeTypeIdFor = (typeId: TypeId, ctx: CodegenContext): number =>
  (() => {
    const key = runtimeTypeKeyFor(typeId, ctx, new Map(), new Map());
    const existing = ctx.runtimeTypeRegistry.get(typeId);
    if (!existing) {
      ctx.runtimeTypeRegistry.set(typeId, { key, moduleId: ctx.moduleId, typeId });
    }

    const cached = ctx.runtimeTypeIds.byKey.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const id = ctx.runtimeTypeIds.nextId.value;
    ctx.runtimeTypeIds.nextId.value += 1;
    ctx.runtimeTypeIds.byKey.set(key, id);
    return id;
  })();

const getLocalSymbolName = (symbol: SymbolId, ctx: CodegenContext): string =>
  ctx.program.symbols.getName(
    ctx.program.symbols.idOf({ moduleId: ctx.moduleId, symbol })
  ) ?? `${symbol}`;

const functionKey = (moduleId: string, symbol: number): string =>
  `${moduleId}::${symbol}`;

const traitMethodHash = ({
  traitSymbol,
  methodSymbol,
}: {
  traitSymbol: number;
  methodSymbol: number;
}): number => murmurHash3(`${traitSymbol}:${methodSymbol}`);

export const getClosureTypeInfo = (
  typeId: TypeId,
  ctx: CodegenContext
): ClosureTypeInfo => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind !== "function") {
    throw new Error("expected function type for closure info");
  }
  return ensureClosureTypeInfo({
    typeId,
    desc,
    ctx,
    seen: new Set<TypeId>(),
    mode: "runtime",
    lowerType: (id, ctx, seen, mode) => wasmTypeFor(id, ctx, seen, mode),
  });
};

export const getFixedArrayWasmTypes = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
  mode: WasmTypeMode = "runtime"
): FixedArrayWasmType => {
  return ensureFixedArrayWasmTypes({
    typeId,
    ctx,
    seen,
    mode,
    lowerType: (id, ctx, seen, mode) => wasmTypeFor(id, ctx, seen, mode),
  });
};

export const wasmTypeFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
  mode: WasmTypeMode = "runtime"
): binaryen.Type => {
  const already = seen.has(typeId);
  if (already) {
    const desc = ctx.program.types.getTypeDesc(typeId);
    if (desc.kind === "function") {
      return binaryen.funcref;
    }
    if (desc.kind === "fixed-array") {
      const elementType = seen.has(desc.element)
        ? ctx.rtt.baseType
        : wasmTypeFor(desc.element, ctx, seen, "runtime");
      return ensureFixedArrayWasmTypesByElement({ elementType, ctx }).type;
    }
    return ctx.rtt.baseType;
  }
  seen.add(typeId);

  try {
    const desc = ctx.program.types.getTypeDesc(typeId);
    if (desc.kind === "recursive") {
      const unfolded = ctx.program.types.substitute(
        desc.body,
        new Map([[desc.binder, typeId]])
      );
      return wasmTypeFor(unfolded, ctx, seen, mode);
    }
    if (desc.kind === "primitive") {
      return mapPrimitiveToWasm(desc.name);
    }

    if (desc.kind === "fixed-array") {
      return getFixedArrayWasmTypes(typeId, ctx, seen, mode).type;
    }

    if (desc.kind === "function") {
      const info = ensureClosureTypeInfo({
        typeId,
        desc,
        ctx,
        seen,
        mode,
        lowerType: (id, ctx, seen, mode) => wasmTypeFor(id, ctx, seen, mode),
      });
      return info.interfaceType;
    }

    if (desc.kind === "trait") {
      return ctx.rtt.baseType;
    }

    if (desc.kind === "nominal-object") {
      if (mode === "signature") {
        return ctx.rtt.baseType;
      }
      const structInfo = getStructuralTypeInfo(typeId, ctx, seen);
      if (!structInfo) {
        throw new Error("missing structural type info");
      }
      return structInfo.interfaceType;
    }

    if (desc.kind === "structural-object") {
      if (mode === "signature") {
        return ctx.rtt.baseType;
      }
      const structInfo = getStructuralTypeInfo(typeId, ctx, seen);
      if (!structInfo) {
        throw new Error("missing structural type info");
      }
      return structInfo.interfaceType;
    }

    if (desc.kind === "union") {
      if (desc.members.length === 0) {
        throw new Error("cannot map empty union to wasm");
      }
      const memberTypes = desc.members.map((member) =>
        wasmTypeFor(member, ctx, seen, mode)
      );
      const first = memberTypes[0]!;
      if (!memberTypes.every((candidate) => candidate === first)) {
        throw new Error("union members map to different wasm types");
      }
      return first;
    }

    if (desc.kind === "intersection" && typeof desc.structural === "number") {
      if (mode === "signature") {
        return ctx.rtt.baseType;
      }
      const structInfo = getStructuralTypeInfo(typeId, ctx, seen);
      if (!structInfo) {
        throw new Error("missing structural type info");
      }
      return structInfo.interfaceType;
    }

    if (desc.kind === "type-param-ref") {
      throw new Error(
        `codegen cannot map unresolved type parameter to wasm (module ${ctx.moduleId}, type ${typeId}, param ${desc.param})`
      );
    }

    throw new Error(
      `codegen cannot map ${desc.kind} types to wasm yet (module ${ctx.moduleId}, type ${typeId})`
    );
  } finally {
    seen.delete(typeId);
  }
};

export const getSymbolTypeId = (
  symbol: SymbolId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId
): TypeId => {
  const typeId = ctx.module.types.getValueType(symbol);
  if (typeof typeId === "number") {
    return substituteTypeForInstance({ typeId, ctx, instanceId });
  }
  throw new Error(
    `codegen missing type information for symbol ${getLocalSymbolName(
      symbol,
      ctx
    )} (module ${ctx.moduleId}, symbol ${symbol})`
  );
};

const getInstanceExprType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId
): TypeId | undefined => {
  if (typeof instanceId !== "number") {
    return undefined;
  }
  const instanceType = ctx.program.functions.getInstanceExprType(instanceId, exprId);
  return typeof instanceType === "number" ? instanceType : undefined;
};

function substituteTypeForInstance({
  typeId,
  ctx,
  instanceId,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  instanceId?: ProgramFunctionInstanceId;
}): TypeId {
  const substitution = buildInstanceSubstitution({ ctx, typeInstanceId: instanceId });
  return substitution ? ctx.program.types.substitute(typeId, substitution) : typeId;
}

export const getRequiredExprType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId
): TypeId => {
  const instanceType = getInstanceExprType(exprId, ctx, instanceId);
  if (typeof instanceType === "number") {
    return substituteTypeForInstance({ typeId: instanceType, ctx, instanceId });
  }
  const resolved = ctx.module.types.getResolvedExprType(exprId);
  if (typeof resolved === "number") {
    return substituteTypeForInstance({ typeId: resolved, ctx, instanceId });
  }
  const typeId = ctx.module.types.getExprType(exprId);
  if (typeof typeId === "number") {
    return substituteTypeForInstance({ typeId, ctx, instanceId });
  }
  throw new Error(`codegen missing type information for expression ${exprId}`);
};

export const getExprBinaryenType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId
): binaryen.Type => {
  const instanceType = getInstanceExprType(exprId, ctx, instanceId);
  if (typeof instanceType === "number") {
    const typeId = substituteTypeForInstance({ typeId: instanceType, ctx, instanceId });
    return wasmTypeFor(typeId, ctx);
  }
  const resolved = ctx.module.types.getResolvedExprType(exprId);
  const baseTypeId =
    typeof resolved === "number" ? resolved : ctx.module.types.getExprType(exprId);
  if (typeof baseTypeId === "number") {
    const typeId = substituteTypeForInstance({ typeId: baseTypeId, ctx, instanceId });
    return wasmTypeFor(typeId, ctx);
  }
  return binaryen.none;
};

export const getTypeIdFromTypeExpr = (
  expr: HirTypeExpr,
  ctx: CodegenContext
): TypeId => {
  if (typeof expr.typeId === "number") {
    return expr.typeId;
  }
  throw new Error("codegen expected type-annotated HIR type expression");
};

export const getMatchPatternTypeId = (
  pattern: HirPattern & { kind: "type" },
  ctx: CodegenContext
): TypeId => {
  if (typeof pattern.typeId === "number") {
    return pattern.typeId;
  }
  return getTypeIdFromTypeExpr(pattern.type, ctx);
};

export const getStructuralTypeInfo = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set()
): StructuralTypeInfo | undefined => {
  const typeDesc = ctx.program.types.getTypeDesc(typeId);
  if (typeDesc.kind === "nominal-object") {
    const info = ctx.program.objects.getInfoByNominal(typeId);
    if (info && info.type !== typeId) {
      return getStructuralTypeInfo(info.type, ctx, seen);
    }
  }
  const structuralId = resolveStructuralTypeId(typeId, ctx);
  if (typeof structuralId !== "number") {
    return undefined;
  }

  const cacheKey = structuralTypeKey(ctx.moduleId, typeId);
  const cached = ctx.structTypes.get(cacheKey);
  if (cached) {
    return cached;
  }

  seen.add(structuralId);
  seen.add(typeId);

  try {
    const desc = ctx.program.types.getTypeDesc(structuralId);
    if (desc.kind !== "structural-object") {
      return undefined;
    }

    const nominalId = getNominalComponentId(typeId, ctx);
    const substitution = (() => {
      if (typeof nominalId !== "number") {
        return undefined;
      }
      const nominalDesc = ctx.program.types.getTypeDesc(nominalId);
      if (nominalDesc.kind !== "nominal-object") {
        return undefined;
      }
      const owner = ctx.program.objects.getNominalOwnerRef(nominalId);
      if (!owner) {
        return undefined;
      }
      const template = ctx.program.objects.getTemplate(owner);
      if (!template) {
        return undefined;
      }
      if (template.params.length !== nominalDesc.typeArgs.length) {
        return undefined;
      }
      return new Map(
        template.params.map(
          (param, index) => [param.typeParam, nominalDesc.typeArgs[index]!] as const
        )
      );
    })();
    const objectInfo =
      typeof nominalId === "number"
        ? ctx.program.objects.getInfoByNominal(nominalId)
        : undefined;
    const sourceFields = objectInfo?.fields ?? desc.fields;
    const fields: StructuralFieldInfo[] = sourceFields.map((field, index) => {
      const fieldTypeId =
        substitution && substitution.size > 0
          ? ctx.program.types.substitute(field.type, substitution)
          : field.type;
      return {
        name: field.name,
        typeId: fieldTypeId,
        wasmType: wasmTypeFor(fieldTypeId, ctx, seen),
        runtimeIndex: index + RTT_METADATA_SLOT_COUNT,
        optional: field.optional,
        hash: 0,
      };
    });
    const nominalAncestry = getNominalAncestry(nominalId, ctx);
    const nominalAncestors = nominalAncestry.map((entry) => entry.nominalId);
    const typeLabel = makeRuntimeTypeLabel({
      moduleLabel: ctx.moduleLabel,
      typeId,
      structuralId,
      nominalId,
    });
    const runtimeTypeId = runtimeTypeIdFor(typeId, ctx);
    const ancestors = buildRuntimeAncestors({
      typeId,
      structuralId,
      nominalAncestry,
      ctx,
    });
    const runtimeType = defineStructType(ctx.mod, {
      name: typeLabel,
      fields: [
        {
          name: "__ancestors_table",
          type: ctx.rtt.extensionHelpers.i32Array,
          mutable: false,
        },
        {
          name: "__field_index_table",
          type: ctx.rtt.fieldLookupHelpers.lookupTableType,
          mutable: false,
        },
        {
          name: "__method_lookup_table",
          type: ctx.rtt.methodLookupHelpers.lookupTableType,
          mutable: false,
        },
        ...fields.map((field) => ({
          name: field.name,
          type: field.wasmType,
          mutable: true,
        })),
      ],
      supertype: binaryenTypeToHeapType(ctx.rtt.baseType),
      final: true,
    });
    const fieldTableExpr = ctx.rtt.fieldLookupHelpers.registerType({
      typeLabel,
      runtimeType,
      baseType: ctx.rtt.baseType,
      fields,
    });
    const methodEntries = createMethodLookupEntries({
      impls:
        typeof nominalId === "number"
          ? ctx.program.traits.getImplsByNominal(nominalId)
          : [],
      ctx,
      typeLabel,
      runtimeType,
    });
    const methodTableExpr =
      ctx.rtt.methodLookupHelpers.createTable(methodEntries);

    const ancestorsGlobal = `__ancestors_table_${typeLabel}`;
    ctx.mod.addGlobal(
      ancestorsGlobal,
      ctx.rtt.extensionHelpers.i32Array,
      false,
      ctx.rtt.extensionHelpers.initExtensionArray(ancestors)
    );

    const fieldTableGlobal = `__field_index_table_${typeLabel}`;
    ctx.mod.addGlobal(
      fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType,
      false,
      fieldTableExpr
    );

    const methodTableGlobal = `__method_table_${typeLabel}`;
    ctx.mod.addGlobal(
      methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType,
      false,
      methodTableExpr
    );

    const info: StructuralTypeInfo = {
      typeId,
      runtimeTypeId,
      structuralId,
      nominalId,
      nominalAncestors,
      runtimeType,
      interfaceType: ctx.rtt.baseType,
      fields,
      fieldMap: new Map(fields.map((field) => [field.name, field])),
      ancestorsGlobal,
      fieldTableGlobal,
      methodTableGlobal,
      typeLabel,
    };
    ctx.structTypes.set(cacheKey, info);
    return info;
  } finally {
    seen.delete(structuralId);
    seen.delete(typeId);
  }
};

export const resolveStructuralTypeId = (
  typeId: TypeId,
  ctx: CodegenContext
): TypeId | undefined => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      desc.body,
      new Map([[desc.binder, typeId]])
    );
    return resolveStructuralTypeId(unfolded, ctx);
  }
  if (desc.kind === "structural-object") {
    return typeId;
  }
  if (desc.kind === "nominal-object") {
    return ctx.program.objects.getInfoByNominal(typeId)?.structural;
  }
  if (desc.kind === "intersection" && typeof desc.structural === "number") {
    return desc.structural;
  }
  return undefined;
};

const makeRuntimeTypeLabel = ({
  moduleLabel,
  typeId,
  structuralId,
  nominalId,
}: {
  moduleLabel: string;
  typeId: TypeId;
  structuralId: TypeId;
  nominalId?: TypeId;
}): string => {
  const nominalPrefix =
    typeof nominalId === "number" ? `nominal_${nominalId}_` : "";
  return `${moduleLabel}__struct_${nominalPrefix}type_${typeId}_shape_${structuralId}`;
};

const isUnknownPrimitive = (typeId: TypeId, ctx: CodegenContext): boolean => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  return desc.kind === "primitive" && desc.name === "unknown";
};

const buildRuntimeAncestors = ({
  typeId,
  structuralId,
  nominalAncestry,
  ctx,
}: {
  typeId: TypeId;
  structuralId: TypeId;
  nominalAncestry: readonly { nominalId: TypeId; typeId: TypeId }[];
  ctx: CodegenContext;
}): number[] => {
  const runtimeIdMemo = new Map<TypeId, number>();
  const runtimeIdFor = (id: TypeId): number => {
    const cached = runtimeIdMemo.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const computed = runtimeTypeIdFor(id, ctx);
    runtimeIdMemo.set(id, computed);
    return computed;
  };

  const seen = new Set<number>();
  const ancestors: number[] = [];
  const add = (id?: TypeId) => {
    if (typeof id !== "number") {
      return;
    }
    const runtimeId = runtimeIdFor(id);
    if (seen.has(runtimeId)) {
      return;
    }
    seen.add(runtimeId);
    ancestors.push(runtimeId);
  };

  add(typeId);
  nominalAncestry.forEach((entry) => {
    add(entry.typeId);
    add(entry.nominalId);
  });
  add(structuralId);

  const addCompatibleSuperInstantiations = (nominalId?: TypeId) => {
    if (typeof nominalId !== "number") {
      return;
    }
    const sourceDesc = ctx.program.types.getTypeDesc(nominalId);
    if (
      sourceDesc.kind !== "nominal-object" ||
      sourceDesc.typeArgs.some((arg) => isUnknownPrimitive(arg, ctx))
    ) {
      return;
    }

    const candidates = ctx.program.objects.getNominalInstancesByOwner(sourceDesc.owner);
    candidates.forEach((candidateNominal) => {
      if (candidateNominal === nominalId) {
        return;
      }
      const info = ctx.program.objects.getInfoByNominal(candidateNominal);
      if (!info || info.nominal !== candidateNominal) {
        return;
      }
      const targetDesc = ctx.program.types.getTypeDesc(candidateNominal);
      if (
        targetDesc.kind !== "nominal-object" ||
        targetDesc.typeArgs.length !== sourceDesc.typeArgs.length ||
        targetDesc.typeArgs.some((arg) => isUnknownPrimitive(arg, ctx))
      ) {
        return;
      }

      const compatible = sourceDesc.typeArgs.every((arg, index) => {
        const targetArg = targetDesc.typeArgs[index]!;
        const forward = ctx.program.types.unify(arg, targetArg, {
          location: ctx.module.hir.module.ast,
          reason: "nominal instantiation compatibility",
          variance: "covariant",
        });
        if (!forward.ok) {
          return false;
        }
        const reverse = ctx.program.types.unify(targetArg, arg, {
          location: ctx.module.hir.module.ast,
          reason: "nominal instantiation compatibility",
          variance: "covariant",
        });
        return reverse.ok;
      });

      if (compatible) {
        add(info.type);
        add(candidateNominal);
      }
    });
  };

  addCompatibleSuperInstantiations(nominalAncestry[0]?.nominalId);

  return ancestors;
};

const pickMethodMetadata = (
  metas: readonly FunctionMetadata[] | undefined
): FunctionMetadata | undefined => {
  if (!metas || metas.length === 0) {
    return undefined;
  }
  const concrete = metas.find((meta) => meta.typeArgs.length === 0);
  return concrete ?? metas[0];
};

const createMethodLookupEntries = ({
  impls,
  ctx,
  typeLabel,
  runtimeType,
}: {
  impls: readonly CodegenTraitImplInstance[];
  ctx: CodegenContext;
  typeLabel: string;
  runtimeType: binaryen.Type;
}): MethodAccessorEntry[] => {
  if (impls.length === 0) {
    return [];
  }
  const entries: MethodAccessorEntry[] = [];
  const hashes = new Map<number, string>();

  impls.forEach((impl) => {
    impl.methods.forEach(({ traitMethod, implMethod }) => {
      const implRef = ctx.program.symbols.refOf(implMethod as ProgramSymbolId);
      const metas = ctx.functions.get(implRef.moduleId)?.get(implRef.symbol);
      const meta = pickMethodMetadata(metas);
      if (!meta) {
        throw new Error(
          `codegen missing metadata for trait method impl ${implMethod}`
        );
      }
      const handlerParamType = ctx.effectsRuntime.handlerFrameType;
      const receiverTypeIndex = meta.effectful ? 1 : 0;
      const receiverType = meta.paramTypes[receiverTypeIndex] ?? runtimeType;
      const userParamTypes = meta.effectful
        ? meta.paramTypes.slice(2)
        : meta.paramTypes.slice(1);
      const params = meta.effectful
        ? [handlerParamType, ctx.rtt.baseType, ...userParamTypes]
        : [ctx.rtt.baseType, ...userParamTypes];
      const wrapperName = `${typeLabel}__method_${impl.traitSymbol}_${traitMethod}`;
      const wrapper = ctx.mod.addFunction(
        wrapperName,
        binaryen.createType(params as number[]),
        meta.resultType,
        [],
        ctx.mod.call(
          meta.wasmName,
          [
            ...(meta.effectful
              ? [
                  ctx.mod.local.get(0, handlerParamType),
                  refCast(
                    ctx.mod,
                    ctx.mod.local.get(1, ctx.rtt.baseType),
                    receiverType
                  ),
                  ...userParamTypes.map((type, index) =>
                    ctx.mod.local.get(index + 2, type)
                  ),
                ]
              : [
                  refCast(
                    ctx.mod,
                    ctx.mod.local.get(0, ctx.rtt.baseType),
                    receiverType
                  ),
                  ...userParamTypes.map((type, index) =>
                    ctx.mod.local.get(index + 1, type)
                  ),
                ]),
          ],
          meta.resultType
        )
      );
      const heapType = bin._BinaryenFunctionGetType(wrapper);
      const fnType = bin._BinaryenTypeFromHeapType(heapType, false);
      const hash = traitMethodHash({
        traitSymbol: impl.traitSymbol,
        methodSymbol: traitMethod,
      });
      const signatureKey = `${impl.traitSymbol}:${traitMethod}`;
      const existing = hashes.get(hash);
      if (existing && existing !== signatureKey) {
        throw new Error(
          [
            `method hash collision detected for ${typeLabel}`,
            `hash: ${hash}`,
            `existing: ${existing}`,
            `new: ${signatureKey}`,
          ].join("\n")
        );
      }
      hashes.set(hash, signatureKey);
      entries.push({
        hash,
        ref: refFunc(ctx.mod, wrapperName, fnType),
      });
    });
  });

  return entries;
};

const structuralTypeKey = (moduleId: string, typeId: TypeId): string =>
  `${moduleId}::${typeId}`;

const getNominalAncestry = (
  nominalId: TypeId | undefined,
  ctx: CodegenContext
): readonly { nominalId: TypeId; typeId: TypeId }[] =>
  typeof nominalId === "number" ? ctx.program.types.getNominalAncestry(nominalId) : [];

const getNominalComponentId = (
  typeId: TypeId,
  ctx: CodegenContext
): TypeId | undefined => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      desc.body,
      new Map([[desc.binder, typeId]])
    );
    return getNominalComponentId(unfolded, ctx);
  }
  if (desc.kind === "nominal-object") {
    return typeId;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return desc.nominal;
  }
  return undefined;
};

// Symbol/name resolution for nominal owners is handled by `ctx.program.symbols`.
