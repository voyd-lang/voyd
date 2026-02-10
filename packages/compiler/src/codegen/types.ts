import binaryen from "binaryen";
import {
  binaryenTypeToHeapType,
  defineStructType,
  refFunc,
  refCast,
  TypeBuilderBuildError,
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
import { pickTraitImplMethodMeta } from "./function-lookup.js";
import type {
  CodegenContext,
  ClosureTypeInfo,
  StructuralFieldInfo,
  StructuralTypeInfo,
  HirTypeExpr,
  HirExprId,
  HirPattern,
  SymbolId,
  FixedArrayWasmType,
} from "./context.js";
import type { MethodAccessorEntry } from "./rtt/method-accessor.js";
import type { CodegenTraitImplInstance } from "../semantics/codegen-view/index.js";
import type {
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  TypeParamId,
  TypeId,
} from "../semantics/ids.js";
import { buildInstanceSubstitution } from "./type-substitution.js";
import { getSccContainingRoot } from "./graph/scc.js";
import { emitRecursiveStructuralHeapTypeGroup } from "./structural-heap-type-emitter.js";

const bin = binaryen as unknown as AugmentedBinaryen;

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

export type WasmTypeMode = "runtime" | "signature";

type RuntimeTypeKeyState = {
  typeId: TypeId;
  ctx: CodegenContext;
  active: Map<TypeId, number>;
  binders: Map<TypeParamId, number>;
};

const runtimeTypeKeyFor = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): string =>
  runtimeTypeKeyForInternal({
    typeId,
    ctx,
    active: new Map<TypeId, number>(),
    binders: new Map<TypeParamId, number>(),
  });

const runtimeTypeKeyForInternal = ({
  typeId,
  ctx,
  active,
  binders,
}: RuntimeTypeKeyState): string => {
  const activeIndex = active.get(typeId);
  if (typeof activeIndex === "number") {
    return `recursive:${activeIndex}`;
  }
  active.set(typeId, active.size);

  try {
    const desc = ctx.program.types.getTypeDesc(typeId);
    switch (desc.kind) {
      case "primitive":
        return `prim:${desc.name}`;
      case "recursive": {
        const binderIndex = binders.size;
        const nextBinders = new Map(binders);
        nextBinders.set(desc.binder, binderIndex);
        return `mu:${binderIndex}.${runtimeTypeKeyForInternal({
          typeId: desc.body,
          ctx,
          active,
          binders: nextBinders,
        })}`;
      }
      case "type-param-ref": {
        const binderIndex = binders.get(desc.param);
        return typeof binderIndex === "number"
          ? `recparam:${binderIndex}`
          : `typeparam:${desc.param}`;
      }
      case "nominal-object":
        return `nominal:${desc.owner}<${desc.typeArgs
          .map((arg) =>
            runtimeTypeKeyForInternal({ typeId: arg, ctx, active, binders }),
          )
          .join(",")}>`;
      case "trait":
        return `trait:${desc.owner}<${desc.typeArgs
          .map((arg) =>
            runtimeTypeKeyForInternal({ typeId: arg, ctx, active, binders }),
          )
          .join(",")}>`;
      case "structural-object":
        return `struct:{${desc.fields
          .map(
            (field) =>
              `${field.name}${field.optional ? "?" : ""}:${runtimeTypeKeyForInternal(
                {
                  typeId: field.type,
                  ctx,
                  active,
                  binders,
                },
              )}`,
          )
          .join(",")}}`;
      case "function":
        return `fn:(${desc.parameters
          .map((param) =>
            runtimeTypeKeyForInternal({
              typeId: param.type,
              ctx,
              active,
              binders,
            }),
          )
          .join(",")})->${runtimeTypeKeyForInternal({
          typeId: desc.returnType,
          ctx,
          active,
          binders,
        })}`;
      case "union": {
        const members = desc.members
          .map((member) =>
            runtimeTypeKeyForInternal({ typeId: member, ctx, active, binders }),
          )
          .sort();
        return `union:${members.join("|")}`;
      }
      case "intersection": {
        const nominal =
          typeof desc.nominal === "number"
            ? runtimeTypeKeyForInternal({
                typeId: desc.nominal,
                ctx,
                active,
                binders,
              })
            : "none";
        const structural =
          typeof desc.structural === "number"
            ? runtimeTypeKeyForInternal({
                typeId: desc.structural,
                ctx,
                active,
                binders,
              })
            : "none";
        const traits =
          desc.traits && desc.traits.length > 0
            ? desc.traits
                .map((trait) =>
                  runtimeTypeKeyForInternal({
                    typeId: trait,
                    ctx,
                    active,
                    binders,
                  }),
                )
                .sort()
                .join("|")
            : "none";
        return `intersection:${nominal}&${structural}&traits:${traits}`;
      }
      case "fixed-array":
        return `fixed-array:${runtimeTypeKeyForInternal({
          typeId: desc.element,
          ctx,
          active,
          binders,
        })}`;
      default:
        return `${(desc as { kind: string }).kind}:${typeId}`;
    }
  } finally {
    active.delete(typeId);
  }
};

const runtimeTypeIdFor = (typeId: TypeId, ctx: CodegenContext): number =>
  (() => {
    const key = runtimeTypeKeyFor({ typeId, ctx });
    const existing = ctx.runtimeTypeRegistry.get(typeId);
    if (!existing) {
      ctx.runtimeTypeRegistry.set(typeId, {
        key,
        moduleId: ctx.moduleId,
        typeId,
      });
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
    ctx.program.symbols.idOf({ moduleId: ctx.moduleId, symbol }),
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
  ctx: CodegenContext,
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
  mode: WasmTypeMode = "runtime",
): FixedArrayWasmType => {
  const activeGroup = ctx.activeRecursiveHeapTypeGroup;
  if (activeGroup) {
    const desc = ctx.program.types.getTypeDesc(typeId);
    if (desc.kind === "fixed-array") {
      const elementStructural = resolveStructuralTypeId(desc.element, ctx);
      if (
        typeof elementStructural === "number" &&
        activeGroup.structuralIds.has(elementStructural)
      ) {
        const tempArrayType =
          activeGroup.fixedArrayTempRefsByElementStructuralId.get(
            elementStructural,
          );
        if (typeof tempArrayType === "number") {
          return {
            type: tempArrayType,
            heapType: binaryenTypeToHeapType(tempArrayType),
          };
        }
      }
    }
  }

  return ensureFixedArrayWasmTypes({
    typeId,
    ctx,
    seen,
    mode,
    // Wasm GC arrays are invariant, so fixed-array element heap types must stay
    // concrete even when the caller is lowering a signature.
    lowerType: (id, ctx, seen) =>
      wasmHeapFieldTypeFor(id, ctx, seen, "runtime"),
  });
};

export const wasmTypeFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
  mode: WasmTypeMode = "runtime",
): binaryen.Type => {
  const already = seen.has(typeId);
  if (already) {
    const desc = ctx.program.types.getTypeDesc(typeId);
    // Recursive heap types are widened for now; see docs/proposals/recursive-heap-types.md.
    if (desc.kind === "function") {
      return binaryen.funcref;
    }
    if (desc.kind === "fixed-array") {
      const elementType = wasmHeapFieldTypeFor(
        desc.element,
        ctx,
        seen,
        "runtime",
      );
      return ensureFixedArrayWasmTypesByElement({ elementType, ctx }).type;
    }
    return ctx.rtt.baseType;
  }
  seen.add(typeId);

  try {
    const desc = ctx.program.types.getTypeDesc(typeId);
    const descKind = desc.kind;
    if (desc.kind === "recursive") {
      ctx.recursiveBinders.set(desc.binder, typeId);
      const unfolded = ctx.program.types.substitute(
        desc.body,
        new Map([[desc.binder, typeId]]),
      );
      return wasmTypeFor(unfolded, ctx, seen, mode);
    }
    if (desc.kind === "primitive") {
      return mapPrimitiveToWasm(desc.name);
    }

    if (desc.kind === "fixed-array") {
      // Fixed arrays are invariant in wasm GC, so signatures must use the concrete
      // runtime array type to remain type-correct.
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
        wasmTypeFor(member, ctx, seen, mode),
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
    if (desc.kind === "intersection") {
      return ctx.rtt.baseType;
    }

    if (desc.kind === "type-param-ref") {
      const binderRecursive = ctx.recursiveBinders.get(desc.param);
      if (typeof binderRecursive === "number") {
        return wasmTypeFor(binderRecursive, ctx, seen, mode);
      }
      const inScopeRecursive = Array.from(seen).find((candidate) => {
        const candidateDesc = ctx.program.types.getTypeDesc(candidate);
        return (
          candidateDesc.kind === "recursive" &&
          candidateDesc.binder === desc.param
        );
      });
      if (typeof inScopeRecursive === "number") {
        return wasmTypeFor(inScopeRecursive, ctx, seen, mode);
      }
      // wasm has no type parameters; treat unresolved params conservatively.
      return ctx.rtt.baseType;
    }

    throw new Error(
      `codegen cannot map ${descKind} types to wasm yet (module ${ctx.moduleId}, type ${typeId})`,
    );
  } finally {
    seen.delete(typeId);
  }
};

const STRUCTURAL_HEAP_TYPE_PREFIX = "voyd_struct_shape";

const structuralHeapTypeName = (structuralId: TypeId): string =>
  `${STRUCTURAL_HEAP_TYPE_PREFIX}_${structuralId}`;

const directStructuralDeps = (
  structuralId: TypeId,
  ctx: CodegenContext,
): TypeId[] => {
  const desc = ctx.program.types.getTypeDesc(structuralId);
  if (desc.kind !== "structural-object") {
    return [];
  }
  const deps = new Set<TypeId>();

  const collect = (root: TypeId): void => {
    const active = new Set<TypeId>();
    const pending: TypeId[] = [root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (active.has(current)) {
        continue;
      }
      active.add(current);

      const resolved = resolveStructuralTypeId(current, ctx);
      if (typeof resolved === "number") {
        deps.add(resolved);
        continue;
      }

      const inner = ctx.program.types.getTypeDesc(current);
      if (inner.kind === "fixed-array") {
        pending.push(inner.element);
        continue;
      }
      if (inner.kind === "union") {
        inner.members.forEach((member) => pending.push(member));
        continue;
      }
      if (inner.kind === "intersection") {
        if (typeof inner.nominal === "number") {
          pending.push(inner.nominal);
        }
        if (typeof inner.structural === "number") {
          pending.push(inner.structural);
        }
        inner.traits?.forEach((trait) => pending.push(trait));
        continue;
      }
      if (inner.kind === "trait") {
        inner.typeArgs.forEach((arg) => pending.push(arg));
        continue;
      }
      if (inner.kind === "function") {
        inner.parameters.forEach((param) => pending.push(param.type));
        pending.push(inner.returnType);
      }
    }
  };

  desc.fields.forEach((field) => collect(field.type));
  return Array.from(deps).sort((a, b) => a - b);
};

const ensureStructuralRuntimeType = (
  structuralId: TypeId,
  ctx: CodegenContext,
): binaryen.Type => {
  const cached = ctx.structHeapTypes.get(structuralId);
  if (cached) {
    return cached;
  }

  const depsCache = new Map<TypeId, readonly TypeId[]>();
  const getDeps = (id: TypeId): readonly TypeId[] => {
    const existing = depsCache.get(id);
    if (existing) {
      return existing;
    }
    const computed = directStructuralDeps(id, ctx);
    depsCache.set(id, computed);
    return computed;
  };

  const scc = getSccContainingRoot({ root: structuralId, getDeps });

  const isRecursive =
    scc.length > 1 || getDeps(structuralId).some((dep) => dep === structuralId);

  const baseHeapType = binaryenTypeToHeapType(ctx.rtt.baseType);

  const lowerNonStructural = (typeId: TypeId): binaryen.Type =>
    wasmTypeFor(typeId, ctx, new Set(), "signature");

  const buildNonRecursive = (id: TypeId): binaryen.Type => {
    getDeps(id).forEach((dep) => {
      if (dep !== id) {
        ensureStructuralRuntimeType(dep, ctx);
      }
    });

    const desc = ctx.program.types.getTypeDesc(id);
    if (desc.kind !== "structural-object") {
      throw new Error(`expected structural-object type ${id}`);
    }

    const structType = defineStructType(ctx.mod, {
      name: structuralHeapTypeName(id),
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
        ...desc.fields.map((field) => {
          const fieldStructural = resolveStructuralTypeId(field.type, ctx);
          const type =
            typeof fieldStructural === "number"
              ? ensureStructuralRuntimeType(fieldStructural, ctx)
              : lowerNonStructural(field.type);
          return { name: field.name, type, mutable: true };
        }),
      ],
      supertype: baseHeapType,
      final: true,
    });
    ctx.structHeapTypes.set(id, structType);
    return structType;
  };

  if (!isRecursive) {
    return buildNonRecursive(structuralId);
  }

  const alreadyBuilt = scc.filter((id) => ctx.structHeapTypes.has(id));
  if (alreadyBuilt.length > 0) {
    const missing = scc.filter((id) => !ctx.structHeapTypes.has(id));
    if (missing.length > 0) {
      throw new Error(
        `partial recursive heap type cache: built [${alreadyBuilt.join(
          ",",
        )}], missing [${missing.join(",")}]`,
      );
    }
    return ctx.structHeapTypes.get(structuralId)!;
  }

  try {
    emitRecursiveStructuralHeapTypeGroup({
      component: scc,
      ctx,
      getDirectDeps: getDeps,
      structNameFor: structuralHeapTypeName,
      resolveStructuralTypeId: (typeId) => resolveStructuralTypeId(typeId, ctx),
      ensureStructuralRuntimeType: (id) => ensureStructuralRuntimeType(id, ctx),
      lowerNonStructural,
      baseHeapType,
    });
  } catch (error) {
    if (error instanceof TypeBuilderBuildError) {
      ctx.diagnostics.report({
        code: "CG_RECURSIVE_HEAP_TYPE_BUILDER_FAILED",
        phase: "codegen",
        message: [
          "failed to build recursive heap type group",
          `module: ${ctx.moduleId}`,
          `structural type: ${structuralId}`,
          `error index: ${error.errorIndex}`,
          `error reason: ${error.errorReason}`,
        ].join("\n"),
        span: { file: ctx.moduleId, start: 0, end: 0 },
      });
    }
    throw error;
  }
  const built = ctx.structHeapTypes.get(structuralId);
  if (!built) {
    throw new Error(
      `failed to cache runtime heap type for structural id ${structuralId}`,
    );
  }
  return built;
};

const wasmStructFieldTypeFor = (
  typeId: TypeId,
  ctx: CodegenContext,
): binaryen.Type => {
  return wasmHeapFieldTypeFor(typeId, ctx);
};

export const wasmHeapFieldTypeFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
  mode: WasmTypeMode = "signature",
): binaryen.Type => {
  const structuralId = resolveStructuralTypeId(typeId, ctx);
  if (typeof structuralId === "number") {
    return ensureStructuralRuntimeType(structuralId, ctx);
  }
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    // Avoid unfolding arbitrary recursive wrappers for field heap types; if a recursive
    // type doesn't resolve to a structural heap type, treat it conservatively.
    return ctx.rtt.baseType;
  }
  return wasmTypeFor(typeId, ctx, seen, mode);
};

export const getSymbolTypeId = (
  symbol: SymbolId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
): TypeId => {
  const instanceType =
    typeof instanceId === "number"
      ? ctx.program.functions.getInstanceValueType(instanceId, symbol)
      : undefined;
  const typeId =
    typeof instanceType === "number"
      ? instanceType
      : ctx.module.types.getValueType(symbol);
  if (typeof typeId === "number") {
    return substituteTypeForInstance({ typeId, ctx, instanceId });
  }
  throw new Error(
    `codegen missing type information for symbol ${getLocalSymbolName(
      symbol,
      ctx,
    )} (module ${ctx.moduleId}, symbol ${symbol})`,
  );
};

const getInstanceExprType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
): TypeId | undefined => {
  if (typeof instanceId !== "number") {
    return undefined;
  }
  const instanceType = ctx.program.functions.getInstanceExprType(
    instanceId,
    exprId,
  );
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
  const substitution = buildInstanceSubstitution({
    ctx,
    typeInstanceId: instanceId,
  });
  return substitution
    ? ctx.program.types.substitute(typeId, substitution)
    : typeId;
}

export const getRequiredExprType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
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

export const getUnresolvedExprType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
): TypeId => {
  const instanceType = getInstanceExprType(exprId, ctx, instanceId);
  if (typeof instanceType === "number") {
    return substituteTypeForInstance({ typeId: instanceType, ctx, instanceId });
  }

  const baseTypeId = ctx.module.types.getExprType(exprId);
  if (typeof baseTypeId === "number") {
    return substituteTypeForInstance({ typeId: baseTypeId, ctx, instanceId });
  }

  throw new Error(`codegen missing type information for expression ${exprId}`);
};

export const getExprBinaryenType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
): binaryen.Type => {
  const instanceType = getInstanceExprType(exprId, ctx, instanceId);
  if (typeof instanceType === "number") {
    const typeId = substituteTypeForInstance({
      typeId: instanceType,
      ctx,
      instanceId,
    });
    return wasmTypeFor(typeId, ctx);
  }
  const resolved = ctx.module.types.getResolvedExprType(exprId);
  const baseTypeId =
    typeof resolved === "number"
      ? resolved
      : ctx.module.types.getExprType(exprId);
  if (typeof baseTypeId === "number") {
    const typeId = substituteTypeForInstance({
      typeId: baseTypeId,
      ctx,
      instanceId,
    });
    return wasmTypeFor(typeId, ctx);
  }
  return binaryen.none;
};

export const getTypeIdFromTypeExpr = (
  expr: HirTypeExpr,
  ctx: CodegenContext,
): TypeId => {
  if (typeof expr.typeId === "number") {
    return expr.typeId;
  }
  throw new Error("codegen expected type-annotated HIR type expression");
};

export const getMatchPatternTypeId = (
  pattern: HirPattern & { kind: "type" },
  ctx: CodegenContext,
): TypeId => {
  if (typeof pattern.typeId === "number") {
    return pattern.typeId;
  }
  return getTypeIdFromTypeExpr(pattern.type, ctx);
};

export const getStructuralTypeInfo = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
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

  try {
    const desc = ctx.program.types.getTypeDesc(structuralId);
    if (desc.kind !== "structural-object") {
      return undefined;
    }

    const runtimeType = ensureStructuralRuntimeType(structuralId, ctx);

    const nominalId = getNominalComponentId(typeId, ctx);
    const substitution = (() => {
      if (typeof nominalId !== "number") {
        return undefined;
      }
      const nominalDesc = ctx.program.types.getTypeDesc(nominalId);
      if (nominalDesc.kind !== "nominal-object") {
        return undefined;
      }
      const owner = nominalDesc.owner;
      if (typeof owner !== "number") {
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
          (param, index) =>
            [param.typeParam, nominalDesc.typeArgs[index]!] as const,
        ),
      );
    })();
    const sourceFields = desc.fields;
    const fields: StructuralFieldInfo[] = sourceFields.map((field, index) => {
      const fieldTypeId =
        substitution && substitution.size > 0
          ? ctx.program.types.substitute(field.type, substitution)
          : field.type;
      const wasmType = wasmTypeFor(fieldTypeId, ctx, new Set(), "signature");
      const heapWasmType = wasmStructFieldTypeFor(fieldTypeId, ctx);
      return {
        name: field.name,
        typeId: fieldTypeId,
        wasmType,
        heapWasmType,
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
    const fieldTableExpr = ctx.rtt.fieldLookupHelpers.registerType({
      typeLabel,
      runtimeType,
      baseType: ctx.rtt.baseType,
      fields,
    });
    const methodEntries = createMethodLookupEntries({
      impls:
        typeof nominalId === "number"
          ? instantiateTraitImplsForNominal({ nominal: nominalId, ctx })
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
      ctx.rtt.extensionHelpers.initExtensionArray(ancestors),
    );

    const fieldTableGlobal = `__field_index_table_${typeLabel}`;
    ctx.mod.addGlobal(
      fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType,
      false,
      fieldTableExpr,
    );

    const methodTableGlobal = `__method_table_${typeLabel}`;
    ctx.mod.addGlobal(
      methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType,
      false,
      methodTableExpr,
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
  }
};

export const resolveStructuralTypeId = (
  typeId: TypeId,
  ctx: CodegenContext,
): TypeId | undefined => {
  const cached = ctx.structuralIdCache.get(typeId);
  if (cached !== undefined || ctx.structuralIdCache.has(typeId)) {
    return cached ?? undefined;
  }
  if (ctx.resolvingStructuralIds.has(typeId)) {
    return undefined;
  }
  ctx.resolvingStructuralIds.add(typeId);

  const desc = ctx.program.types.getTypeDesc(typeId);
  try {
    const resolved = (() => {
      if (desc.kind === "recursive") {
        const unfolded = ctx.program.types.substitute(
          desc.body,
          new Map([[desc.binder, typeId]]),
        );
        return resolveStructuralTypeId(unfolded, ctx);
      }
      if (desc.kind === "structural-object") {
        return typeId;
      }
      if (desc.kind === "nominal-object") {
        const info = ctx.program.objects.getInfoByNominal(typeId);
        if (info) {
          return info.structural;
        }
        const owner = desc.owner;
        if (typeof owner !== "number") {
          return undefined;
        }
        const template = ctx.program.objects.getTemplate(owner);
        if (!template) {
          return undefined;
        }
        if (template.params.length !== desc.typeArgs.length) {
          return undefined;
        }
        const substitution = new Map(
          template.params.map(
            (param, index) => [param.typeParam, desc.typeArgs[index]!] as const,
          ),
        );
        return ctx.program.types.substitute(template.structural, substitution);
      }
      if (desc.kind === "intersection" && typeof desc.structural === "number") {
        return desc.structural;
      }
      return undefined;
    })();

    ctx.structuralIdCache.set(
      typeId,
      typeof resolved === "number" ? resolved : null,
    );
    return resolved;
  } finally {
    ctx.resolvingStructuralIds.delete(typeId);
  }
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

    const candidates = ctx.program.objects.getNominalInstancesByOwner(
      sourceDesc.owner,
    );

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
        return forward.ok;
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

const instantiateTraitImplsForNominal = ({
  nominal,
  ctx,
}: {
  nominal: TypeId;
  ctx: CodegenContext;
}): readonly CodegenTraitImplInstance[] => {
  const existing = ctx.program.traits.getImplsByNominal(nominal);
  if (existing.length > 0) {
    return existing;
  }

  const nominalDesc = ctx.program.types.getTypeDesc(nominal);
  if (nominalDesc.kind !== "nominal-object") {
    return [];
  }

  const templates = ctx.program.traits.getImplTemplates();
  if (templates.length === 0) {
    return [];
  }

  const instances = templates.flatMap((template) => {
    const match = ctx.program.types.unify(nominal, template.target, {
      location: ctx.module.hir.module.ast,
      reason: "codegen trait impl instantiation",
      variance: "invariant",
    });
    if (!match.ok) {
      return [];
    }
    const trait = ctx.program.types.substitute(
      template.trait,
      match.substitution,
    );
    const target = ctx.program.types.substitute(
      template.target,
      match.substitution,
    );
    return [
      {
        trait,
        traitSymbol: template.traitSymbol,
        target,
        methods: template.methods.map(({ traitMethod, implMethod }) => ({
          traitMethod,
          implMethod,
        })),
        implSymbol: template.implSymbol,
      },
    ] satisfies readonly CodegenTraitImplInstance[];
  });

  const seen = new Set<ProgramSymbolId>();
  return instances.filter((impl) => {
    if (seen.has(impl.implSymbol)) {
      return false;
    }
    seen.add(impl.implSymbol);
    return true;
  });
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
      const meta = pickTraitImplMethodMeta({
        metas,
        impl,
        runtimeType,
        ctx,
      });
      if (!meta) {
        const signature = ctx.program.functions.getSignature(
          implRef.moduleId,
          implRef.symbol,
        );
        if (signature?.typeParams.length) {
          // Generic impl methods may be unreachable in this compilation unit.
          // Skip unresolved entries so unrelated RTT generation can continue.
          return;
        }
        const availableInstances = (metas ?? [])
          .map((entry) => {
            const receiverTypeIndex = entry.effectful ? 1 : 0;
            const receiverType =
              entry.paramTypes[receiverTypeIndex] ?? runtimeType;
            const receiverTypeId = entry.paramTypeIds[receiverTypeIndex];
            return `${entry.wasmName}#${entry.instanceId}@${receiverType}(receiverTypeId=${receiverTypeId},typeArgs=[${entry.typeArgs.join(",")}])`;
          })
          .join(", ");
        throw new Error(
          [
            "codegen missing metadata for trait method impl",
            `impl: ${implRef.moduleId}::${implRef.symbol}`,
            `trait method: ${impl.traitSymbol}:${traitMethod}`,
            `runtime type: ${runtimeType}`,
            `impl target: ${impl.target}`,
            `impl trait: ${impl.trait}`,
            `available instances: ${availableInstances || "<none>"}`,
          ].join("\n"),
        );
      }
      if (!meta.wasmName) {
        throw new Error(
          `codegen missing wasm symbol for trait method impl ${implRef.moduleId}::${implRef.symbol}`,
        );
      }
      if (meta.paramTypes.length === 0) {
        throw new Error(
          `codegen missing receiver parameter type for trait method impl ${implRef.moduleId}::${implRef.symbol}`,
        );
      }
      if (meta.effectful && meta.paramTypes.length < 2) {
        throw new Error(
          `codegen missing effectful receiver parameter type for trait method impl ${implRef.moduleId}::${implRef.symbol}`,
        );
      }
      const receiverTypeIndex = meta.effectful ? 1 : 0;
      const receiverType = meta.paramTypes[receiverTypeIndex];
      if (typeof receiverType !== "number") {
        throw new Error(
          `codegen missing receiver wasm type for trait method impl ${implRef.moduleId}::${implRef.symbol}`,
        );
      }
      const userParamTypes = meta.effectful
        ? meta.paramTypes.slice(2)
        : meta.paramTypes.slice(1);
      if (
        meta.effectful &&
        userParamTypes.length + 2 !== meta.paramTypes.length
      ) {
        throw new Error(
          `codegen malformed effectful parameter metadata for trait method impl ${implRef.moduleId}::${implRef.symbol}`,
        );
      }
      if (
        !meta.effectful &&
        userParamTypes.length + 1 !== meta.paramTypes.length
      ) {
        throw new Error(
          `codegen malformed parameter metadata for trait method impl ${implRef.moduleId}::${implRef.symbol}`,
        );
      }
      const handlerParamType = ctx.effectsRuntime.handlerFrameType;
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
                    receiverType,
                  ),
                  ...userParamTypes.map((type, index) =>
                    ctx.mod.local.get(index + 2, type),
                  ),
                ]
              : [
                  refCast(
                    ctx.mod,
                    ctx.mod.local.get(0, ctx.rtt.baseType),
                    receiverType,
                  ),
                  ...userParamTypes.map((type, index) =>
                    ctx.mod.local.get(index + 1, type),
                  ),
                ]),
          ],
          meta.resultType,
        ),
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
          ].join("\n"),
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

const structuralTypeKey = (_moduleId: string, typeId: TypeId): string =>
  `${typeId}`;

const getNominalAncestry = (
  nominalId: TypeId | undefined,
  ctx: CodegenContext,
): readonly { nominalId: TypeId; typeId: TypeId }[] =>
  typeof nominalId === "number"
    ? ctx.program.types.getNominalAncestry(nominalId)
    : [];

const getNominalComponentId = (
  typeId: TypeId,
  ctx: CodegenContext,
): TypeId | undefined => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      desc.body,
      new Map([[desc.binder, typeId]]),
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
