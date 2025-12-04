import binaryen from "binaryen";
import {
  binaryenTypeToHeapType,
  defineArrayType,
  defineStructType,
  refFunc,
  refCast,
} from "@voyd/lib/binaryen-gc/index.js";
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
import type { TraitImplInstance } from "../semantics/typing/types.js";

const bin = binaryen as unknown as AugmentedBinaryen;

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const functionKey = (moduleId: string, symbol: number): string =>
  `${moduleId}::${symbol}`;

const traitMethodHash = ({
  traitSymbol,
  methodSymbol,
}: {
  traitSymbol: number;
  methodSymbol: number;
}): number => murmurHash3(`${traitSymbol}:${methodSymbol}`);

const closureSignatureKey = ({
  moduleId,
  parameters,
  returnType,
  effects,
}: {
  moduleId: string;
  parameters: ReadonlyArray<{ type: TypeId; label?: string; optional?: boolean }>;
  returnType: TypeId;
  effects: unknown;
}): string => {
  const params = parameters
    .map((param) => {
      const label = param.label ?? "_";
      const optional = param.optional ? "?" : "";
      return `${label}:${param.type}${optional}`;
    })
    .join("|");
  return `${moduleId}::(${params})->${returnType}|${effects}`;
};

const closureStructName = ({
  moduleLabel,
  key,
}: {
  moduleLabel: string;
  key: string;
}): string => `${moduleLabel}__closure_base_${sanitizeIdentifier(key)}`;

const getClosureFunctionRefType = ({
  params,
  result,
  ctx,
}: {
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.Type => {
  const key = `${params.join(",")}->${result}`;
  const cached = ctx.closureFunctionTypes.get(key);
  if (cached) {
    return cached;
  }
  const tempName = `__closure_sig_${ctx.closureFunctionTypes.size}`;
  const fnRef = ctx.mod.addFunction(
    tempName,
    binaryen.createType(params as number[]),
    result,
    [],
    ctx.mod.nop()
  );
  const fnType = bin._BinaryenTypeFromHeapType(
    bin._BinaryenFunctionGetType(fnRef),
    false
  );
  ctx.closureFunctionTypes.set(key, fnType);
  ctx.mod.removeFunction(tempName);
  return fnType;
};

const ensureClosureTypeInfo = ({
  typeId,
  desc,
  ctx,
  seen,
}: {
  typeId: TypeId;
  desc: { parameters: ReadonlyArray<{ type: TypeId; label?: string; optional?: boolean }>; returnType: TypeId; effects: unknown };
  ctx: CodegenContext;
  seen: Set<TypeId>;
}): ClosureTypeInfo => {
  const key = closureSignatureKey({
    moduleId: ctx.moduleId,
    parameters: desc.parameters,
    returnType: desc.returnType,
    effects: desc.effects,
  });
  const cached = ctx.closureTypes.get(key);
  if (cached) {
    return cached;
  }

  const paramTypes = desc.parameters.map((param) =>
    wasmTypeFor(param.type, ctx, seen)
  );
  const resultType = wasmTypeFor(desc.returnType, ctx, seen);
  const interfaceType = defineStructType(ctx.mod, {
    name: closureStructName({ moduleLabel: ctx.moduleLabel, key }),
    fields: [{ name: "__fn", type: binaryen.funcref, mutable: false }],
    final: false,
  });
  const fnRefType = getClosureFunctionRefType({
    params: [interfaceType, ...paramTypes],
    result: resultType,
    ctx,
  });
  const info: ClosureTypeInfo = {
    key,
    typeId,
    interfaceType,
    fnRefType,
    paramTypes,
    resultType,
  };
  ctx.closureTypes.set(key, info);
  return info;
};

export const getClosureTypeInfo = (
  typeId: TypeId,
  ctx: CodegenContext
): ClosureTypeInfo => {
  const desc = ctx.typing.arena.get(typeId);
  if (desc.kind !== "function") {
    throw new Error("expected function type for closure info");
  }
  return ensureClosureTypeInfo({
    typeId,
    desc,
    ctx,
    seen: new Set<TypeId>(),
  });
};

export const getFixedArrayWasmTypes = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set()
): FixedArrayWasmType => {
  const desc = ctx.typing.arena.get(typeId);
  if (desc.kind !== "fixed-array") {
    throw new Error("intrinsic requires a fixed-array type");
  }
  const cached = ctx.fixedArrayTypes.get(desc.element);
  if (cached) {
    return cached;
  }
  const elementType = wasmTypeFor(desc.element, ctx, seen);
  const type = defineArrayType(ctx.mod, elementType, true);
  const heapType = binaryenTypeToHeapType(type);
  const fixedArrayType: FixedArrayWasmType = { type, heapType };
  ctx.fixedArrayTypes.set(desc.element, fixedArrayType);
  return fixedArrayType;
};

export const wasmTypeFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set()
): binaryen.Type => {
  const already = seen.has(typeId);
  if (already) {
    const desc = ctx.typing.arena.get(typeId);
    if (desc.kind === "function") {
      return binaryen.funcref;
    }
    return ctx.rtt.baseType;
  }
  seen.add(typeId);

  try {
    const desc = ctx.typing.arena.get(typeId);
    if (desc.kind === "primitive") {
      return mapPrimitiveToWasm(desc.name);
    }

    if (desc.kind === "fixed-array") {
      return getFixedArrayWasmTypes(typeId, ctx, seen).type;
    }

    if (desc.kind === "function") {
      const info = ensureClosureTypeInfo({ typeId, desc, ctx, seen });
      return info.interfaceType;
    }

    if (desc.kind === "trait") {
      return ctx.rtt.baseType;
    }

    if (desc.kind === "structural-object") {
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
        wasmTypeFor(member, ctx, seen)
      );
      const first = memberTypes[0]!;
      if (!memberTypes.every((candidate) => candidate === first)) {
        throw new Error("union members map to different wasm types");
      }
      return first;
    }

    if (desc.kind === "intersection" && typeof desc.structural === "number") {
      return wasmTypeFor(desc.structural, ctx, seen);
    }

    throw new Error(
      `codegen cannot map ${desc.kind} types to wasm yet (type ${typeId})`
    );
  } finally {
    seen.delete(typeId);
  }
};

export const mapPrimitiveToWasm = (name: string): binaryen.Type => {
  switch (name) {
    case "i32":
    case "bool":
    case "boolean":
    case "unknown":
      return binaryen.i32;
    case "i64":
      return binaryen.i64;
    case "f32":
      return binaryen.f32;
    case "f64":
      return binaryen.f64;
    case "voyd":
    case "void":
    case "Voyd":
      return binaryen.none;
    default:
      throw new Error(`unsupported primitive type ${name}`);
  }
};

export const getSymbolTypeId = (
  symbol: SymbolId,
  ctx: CodegenContext
): TypeId => {
  const typeId = ctx.typing.valueTypes.get(symbol);
  if (typeof typeId === "number") {
    return typeId;
  }
  throw new Error(
    `codegen missing type information for symbol ${getSymbolName(symbol, ctx)}`
  );
};

const getInstanceExprType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceKey?: string
): TypeId | undefined => {
  if (!instanceKey) {
    return undefined;
  }
  const instanceType = ctx.typing.functionInstanceExprTypes
    ?.get(instanceKey)
    ?.get(exprId);
  return typeof instanceType === "number" ? instanceType : undefined;
};

export const getRequiredExprType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceKey?: string
): TypeId => {
  const instanceType = getInstanceExprType(exprId, ctx, instanceKey);
  if (typeof instanceType === "number") {
    return instanceType;
  }
  const resolved = ctx.typing.resolvedExprTypes.get(exprId);
  if (typeof resolved === "number") {
    return resolved;
  }
  const typeId = ctx.typing.table.getExprType(exprId);
  if (typeof typeId === "number") {
    return typeId;
  }
  throw new Error(`codegen missing type information for expression ${exprId}`);
};

export const getExprBinaryenType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceKey?: string
): binaryen.Type => {
  const instanceType = getInstanceExprType(exprId, ctx, instanceKey);
  if (typeof instanceType === "number") {
    return wasmTypeFor(instanceType, ctx);
  }
  const resolved = ctx.typing.resolvedExprTypes.get(exprId);
  const typeId =
    typeof resolved === "number"
      ? resolved
      : ctx.typing.table.getExprType(exprId);
  if (typeof typeId === "number") {
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
    const desc = ctx.typing.arena.get(structuralId);
    if (desc.kind !== "structural-object") {
      return undefined;
    }

    const fields: StructuralFieldInfo[] = desc.fields.map((field, index) => ({
      name: field.name,
      typeId: field.type,
      wasmType: wasmTypeFor(field.type, ctx, seen),
      runtimeIndex: index + RTT_METADATA_SLOT_COUNT,
      hash: 0,
    }));
    const nominalId = getNominalComponentId(typeId, ctx);
    const nominalAncestry = getNominalAncestry(nominalId, ctx);
    const nominalAncestors = nominalAncestry.map((entry) => entry.nominalId);
    const typeLabel = makeRuntimeTypeLabel({
      moduleLabel: ctx.moduleLabel,
      typeId,
      structuralId,
      nominalId,
    });
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
          ? ctx.typing.traitImplsByNominal.get(nominalId) ?? []
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
  const desc = ctx.typing.arena.get(typeId);
  if (desc.kind === "structural-object") {
    return typeId;
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

type NominalAncestryEntry = {
  nominalId: TypeId;
  typeId: TypeId;
};

const isUnknownPrimitive = (
  typeId: TypeId,
  ctx: CodegenContext
): boolean => {
  const desc = ctx.typing.arena.get(typeId);
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
  nominalAncestry: readonly NominalAncestryEntry[];
  ctx: CodegenContext;
}): number[] => {
  const seen = new Set<number>();
  const ancestors: number[] = [];
  const add = (id?: TypeId) => {
    if (typeof id !== "number" || seen.has(id)) {
      return;
    }
    seen.add(id);
    ancestors.push(id);
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
    const sourceDesc = ctx.typing.arena.get(nominalId);
    if (
      sourceDesc.kind !== "nominal-object" ||
      sourceDesc.typeArgs.some((arg) => isUnknownPrimitive(arg, ctx))
    ) {
      return;
    }

    ctx.typing.objectsByNominal.forEach((info) => {
      if (info.nominal === nominalId) {
        return;
      }
      const targetDesc = ctx.typing.arena.get(info.nominal);
      if (
        targetDesc.kind !== "nominal-object" ||
        targetDesc.owner !== sourceDesc.owner ||
        targetDesc.typeArgs.length !== sourceDesc.typeArgs.length ||
        targetDesc.typeArgs.some((arg) => isUnknownPrimitive(arg, ctx))
      ) {
        return;
      }

      const compatible = sourceDesc.typeArgs.every((arg, index) => {
        const targetArg = targetDesc.typeArgs[index]!;
        const forward = ctx.typing.arena.unify(arg, targetArg, {
          location: ctx.hir.module.ast,
          reason: "nominal instantiation compatibility",
          variance: "covariant",
        });
        return forward.ok;
      });

      if (compatible) {
        add(info.type);
        add(info.nominal);
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
  impls: readonly TraitImplInstance[];
  ctx: CodegenContext;
  typeLabel: string;
  runtimeType: binaryen.Type;
}): MethodAccessorEntry[] => {
  if (impls.length === 0) {
    return [];
  }
  const entries: MethodAccessorEntry[] = [];

  impls.forEach((impl) => {
    impl.methods.forEach((implMethodSymbol, traitMethodSymbol) => {
      const metas = ctx.functions.get(
        functionKey(ctx.moduleId, implMethodSymbol)
      );
      const meta = pickMethodMetadata(metas);
      if (!meta) {
        throw new Error(
          `codegen missing metadata for trait method impl ${implMethodSymbol}`
        );
      }
      const params = [
        ctx.rtt.baseType,
        ...meta.paramTypes.slice(1),
      ];
      const receiverType = meta.paramTypes[0] ?? runtimeType;
      const wrapperName = `${typeLabel}__method_${impl.traitSymbol}_${traitMethodSymbol}`;
      const wrapper = ctx.mod.addFunction(
        wrapperName,
        binaryen.createType(params as number[]),
        meta.resultType,
        [],
        ctx.mod.call(
          meta.wasmName,
          [
            refCast(
              ctx.mod,
              ctx.mod.local.get(0, ctx.rtt.baseType),
              receiverType
            ),
            ...meta.paramTypes.slice(1).map((type, index) =>
              ctx.mod.local.get(index + 1, type)
            ),
          ],
          meta.resultType
        )
      );
      const heapType = bin._BinaryenFunctionGetType(wrapper);
      const fnType = bin._BinaryenTypeFromHeapType(heapType, false);
      entries.push({
        hash: traitMethodHash({
          traitSymbol: impl.traitSymbol,
          methodSymbol: traitMethodSymbol,
        }),
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
): NominalAncestryEntry[] => {
  const ancestry: NominalAncestryEntry[] = [];
  const seen = new Set<TypeId>();
  let current = nominalId;

  while (typeof current === "number" && !seen.has(current)) {
    const info = ctx.typing.objectsByNominal.get(current);
    if (!info) {
      const owner = getNominalOwner(current, ctx);
      const template = ctx.typing.objects.getTemplate(owner);
      if (template) {
        const typeId =
          template.type ??
          ctx.typing.arena.internIntersection({
            nominal: current,
            structural: template.structural,
          });
        ancestry.push({
          nominalId: current,
          typeId,
        });
        seen.add(current);
        current = template.baseNominal;
        continue;
      }
      const name = getSymbolName(owner, ctx);
      throw new Error(
        `codegen missing nominal ancestry for ${name}<${current}> (nominal ${current})`
      );
    }
    ancestry.push({
      nominalId: current,
      typeId: info.type,
    });
    seen.add(current);
    if (!info.baseNominal) {
      break;
    }
    current = info.baseNominal;
  }

  return ancestry;
};

const getNominalComponentId = (
  typeId: TypeId,
  ctx: CodegenContext
): TypeId | undefined => {
  const desc = ctx.typing.arena.get(typeId);
  if (desc.kind === "nominal-object") {
    return typeId;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return desc.nominal;
  }
  return undefined;
};

const getNominalOwner = (nominalId: TypeId, ctx: CodegenContext): SymbolId => {
  const desc = ctx.typing.arena.get(nominalId);
  if (desc.kind !== "nominal-object") {
    throw new Error("expected nominal type");
  }
  return desc.owner;
};

const getSymbolName = (symbol: SymbolId, ctx: CodegenContext): string =>
  ctx.symbolTable.getSymbol(symbol).name;
