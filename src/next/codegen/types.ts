import binaryen from "binaryen";
import {
  binaryenTypeToHeapType,
  defineStructType,
} from "../../lib/binaryen-gc/index.js";
import { RTT_METADATA_SLOT_COUNT } from "./rtt/index.js";
import type {
  CodegenContext,
  StructuralFieldInfo,
  StructuralTypeInfo,
  HirTypeExpr,
  HirExprId,
  SymbolId,
  TypeId,
} from "./context.js";

export const wasmTypeFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set()
): binaryen.Type => {
  const already = seen.has(typeId);
  if (already) {
    return ctx.rtt.baseType;
  }
  seen.add(typeId);

  try {
    const desc = ctx.typing.arena.get(typeId);
    if (desc.kind === "primitive") {
      return mapPrimitiveToWasm(desc.name);
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

    throw new Error(`codegen cannot map ${desc.kind} types to wasm yet`);
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

export const getRequiredExprType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceKey?: string
): TypeId => {
  if (instanceKey) {
    const instanceType = ctx.typing.functionInstanceExprTypes
      ?.get(instanceKey)
      ?.get(exprId);
    if (typeof instanceType === "number") {
      return instanceType;
    }
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
  if (instanceKey) {
    const instanceType = ctx.typing.functionInstanceExprTypes
      ?.get(instanceKey)
      ?.get(exprId);
    if (typeof instanceType === "number") {
      return wasmTypeFor(instanceType, ctx);
    }
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

export const resolvePatternTypeForMatch = (
  type: HirTypeExpr,
  discriminantTypeId: TypeId,
  ctx: CodegenContext
): TypeId => {
  const resolved = getTypeIdFromTypeExpr(type, ctx);
  const narrowed = narrowPatternType(resolved, discriminantTypeId, ctx);
  return typeof narrowed === "number" ? narrowed : resolved;
};

export const narrowPatternType = (
  patternTypeId: TypeId,
  discriminantTypeId: TypeId,
  ctx: CodegenContext
): TypeId | undefined => {
  const patternNominal = getNominalComponentId(patternTypeId, ctx);
  if (typeof patternNominal !== "number") {
    return undefined;
  }

  const discriminantDesc = ctx.typing.arena.get(discriminantTypeId);
  if (discriminantDesc.kind === "union") {
    const matches = discriminantDesc.members.filter((member) =>
      nominalOwnersMatch(patternNominal, member, ctx)
    );
    if (matches.length === 1) {
      return matches[0]!;
    }
    return undefined;
  }

  return nominalOwnersMatch(patternNominal, discriminantTypeId, ctx)
    ? discriminantTypeId
    : undefined;
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

  const cached = ctx.structTypes.get(typeId);
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
    const methodTableExpr = ctx.rtt.methodLookupHelpers.createTable([]);

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
    ctx.structTypes.set(typeId, info);
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
  typeId,
  structuralId,
  nominalId,
}: {
  typeId: TypeId;
  structuralId: TypeId;
  nominalId?: TypeId;
}): string => {
  const nominalPrefix =
    typeof nominalId === "number" ? `nominal_${nominalId}_` : "";
  return `struct_${nominalPrefix}type_${typeId}_shape_${structuralId}`;
};

type NominalAncestryEntry = {
  nominalId: TypeId;
  typeId: TypeId;
};

const widenNominalAncestors = (
  nominalId: TypeId | undefined,
  ctx: CodegenContext
): number[] => {
  if (typeof nominalId !== "number") {
    return [];
  }

  const nominalDesc = ctx.typing.arena.get(nominalId);
  if (nominalDesc.kind !== "nominal-object") {
    return [];
  }

  const compatible: number[] = [];
  for (const info of ctx.typing.objectsByNominal.values()) {
    if (info.nominal === nominalId) {
      continue;
    }
    const candidateDesc = ctx.typing.arena.get(info.nominal);
    if (
      candidateDesc.kind !== "nominal-object" ||
      candidateDesc.owner !== nominalDesc.owner ||
      candidateDesc.typeArgs.length !== nominalDesc.typeArgs.length
    ) {
      continue;
    }

    let ok = true;
    for (let index = 0; index < nominalDesc.typeArgs.length; index += 1) {
      const unified = ctx.typing.arena.unify(
        nominalDesc.typeArgs[index]!,
        candidateDesc.typeArgs[index]!,
        {
          location: ctx.hir.module.ast,
          reason: "nominal ancestor widening",
          variance: "covariant",
        }
      );
      if (!unified.ok) {
        ok = false;
        break;
      }
    }

    if (ok) {
      compatible.push(info.type);
    }
  }

  return compatible;
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
  widenNominalAncestors(nominalAncestry[0]?.nominalId, ctx).forEach((id) =>
    add(id)
  );

  return ancestors;
};

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

const nominalOwnersMatch = (
  patternNominal: TypeId,
  candidateType: TypeId,
  ctx: CodegenContext
): boolean => {
  const candidateNominal = getNominalComponentId(candidateType, ctx);
  if (typeof candidateNominal !== "number") {
    return false;
  }
  return (
    getNominalOwner(candidateNominal, ctx) ===
    getNominalOwner(patternNominal, ctx)
  );
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
