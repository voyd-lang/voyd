import binaryen from "binaryen";
import {
  annotateStructNames,
  binaryenTypeToHeapType,
  defineStructType,
  refFunc,
  refCast,
  TypeBuilder,
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
        return `intersection:${nominal}&${structural}`;
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
	      const elementType = seen.has(desc.element)
	        ? ctx.rtt.baseType
	        : wasmTypeFor(desc.element, ctx, seen, mode);
	      return ensureFixedArrayWasmTypesByElement({ elementType, ctx }).type;
	    }
	    return ctx.rtt.baseType;
	  }
  seen.add(typeId);

  try {
    const desc = ctx.program.types.getTypeDesc(typeId);
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

	    if (desc.kind === "type-param-ref") {
	      const binderRecursive = ctx.recursiveBinders.get(desc.param);
	      if (typeof binderRecursive === "number") {
	        return wasmTypeFor(binderRecursive, ctx, seen, mode);
	      }
      const inScopeRecursive = Array.from(seen).find((candidate) => {
        const candidateDesc = ctx.program.types.getTypeDesc(candidate);
        return candidateDesc.kind === "recursive" && candidateDesc.binder === desc.param;
      });
	      if (typeof inScopeRecursive === "number") {
	        return wasmTypeFor(inScopeRecursive, ctx, seen, mode);
	      }
	      // wasm has no type parameters; treat unresolved params conservatively.
	      return ctx.rtt.baseType;
	    }

    throw new Error(
      `codegen cannot map ${desc.kind} types to wasm yet (module ${ctx.moduleId}, type ${typeId})`,
    );
  } finally {
    seen.delete(typeId);
  }
};

const STRUCTURAL_HEAP_TYPE_PREFIX = "voyd_struct_shape";

const structuralHeapTypeName = (structuralId: TypeId): string =>
  `${STRUCTURAL_HEAP_TYPE_PREFIX}_${structuralId}`;

const directStructuralDeps = (structuralId: TypeId, ctx: CodegenContext): TypeId[] => {
  const desc = ctx.program.types.getTypeDesc(structuralId);
  if (desc.kind !== "structural-object") {
    return [];
  }
  const deps = new Set<TypeId>();
  desc.fields.forEach((field) => {
    const dep = resolveStructuralTypeId(field.type, ctx);
    if (typeof dep === "number") {
      deps.add(dep);
    }
  });
  return Array.from(deps).sort((a, b) => a - b);
};

const ensureStructuralRuntimeType = (structuralId: TypeId, ctx: CodegenContext): binaryen.Type => {
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

  const scc = (() => {
    const root = structuralId;

    const adjacency = new Map<TypeId, readonly TypeId[]>();
    const reachable = new Set<TypeId>();
    const pending = [root];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (reachable.has(id)) {
        continue;
      }
      reachable.add(id);
      const deps = getDeps(id);
      adjacency.set(id, deps);
      deps.forEach((dep) => {
        if (!reachable.has(dep)) {
          pending.push(dep);
        }
      });
    }

    const nodes = Array.from(reachable).sort((a, b) => a - b);

    const reverseAdj = new Map<TypeId, TypeId[]>();
    nodes.forEach((id) => reverseAdj.set(id, []));
    adjacency.forEach((deps, from) => {
      deps.forEach((to) => {
        const list = reverseAdj.get(to);
        if (list) {
          list.push(from);
        }
      });
    });
    reverseAdj.forEach((list) => list.sort((a, b) => a - b));

    const order: TypeId[] = [];
    const visited = new Set<TypeId>();
    nodes.forEach((start) => {
      if (visited.has(start)) {
        return;
      }
      visited.add(start);
      const stack: { node: TypeId; nextIndex: number }[] = [
        { node: start, nextIndex: 0 },
      ];
      while (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        const deps = adjacency.get(top.node) ?? [];
        if (top.nextIndex < deps.length) {
          const dep = deps[top.nextIndex]!;
          top.nextIndex += 1;
          if (!visited.has(dep)) {
            visited.add(dep);
            stack.push({ node: dep, nextIndex: 0 });
          }
          continue;
        }
        stack.pop();
        order.push(top.node);
      }
    });

    const visitedRev = new Set<TypeId>();
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const start = order[i]!;
      if (visitedRev.has(start)) {
        continue;
      }
      const component: TypeId[] = [];
      visitedRev.add(start);
      const stack = [start];
      while (stack.length > 0) {
        const node = stack.pop()!;
        component.push(node);
        const incoming = reverseAdj.get(node) ?? [];
        incoming.forEach((pred) => {
          if (!visitedRev.has(pred)) {
            visitedRev.add(pred);
            stack.push(pred);
          }
        });
      }
      if (component.includes(root)) {
        return component.sort((a, b) => a - b);
      }
    }

    return [root];
  })();

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

  const buildRecursiveGroup = (component: readonly TypeId[]): void => {
    const inGroup = new Set(component);
    component.forEach((id) => {
      getDeps(id).forEach((dep) => {
        if (!inGroup.has(dep)) {
          ensureStructuralRuntimeType(dep, ctx);
        }
      });
    });

    const indexByType = new Map<TypeId, number>(
      component.map((id, index) => [id, index] as const),
    );

    const builder = new TypeBuilder(component.length);
    const defs: {
      id: TypeId;
      name: string;
      fields: {
        name?: string;
        type: binaryen.Type;
        mutable: boolean;
        packedType?: number;
      }[];
    }[] = [];

    component.forEach((id, index) => {
      const desc = ctx.program.types.getTypeDesc(id);
      if (desc.kind !== "structural-object") {
        throw new Error(`expected structural-object type ${id}`);
      }

      const structName = structuralHeapTypeName(id);
      const fields = [
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
          if (typeof fieldStructural === "number") {
            const groupIndex = indexByType.get(fieldStructural);
            const type =
              typeof groupIndex === "number"
                ? builder.getTempRefType(groupIndex, true)
                : ensureStructuralRuntimeType(fieldStructural, ctx);
            return { name: field.name, type, mutable: true };
          }
          return { name: field.name, type: lowerNonStructural(field.type), mutable: true };
        }),
      ];

      builder.setStruct(index, { name: structName, fields });
      builder.setSubType(index, baseHeapType);
      defs.push({ id, name: structName, fields });
    });

    try {
      const heapTypes = builder.buildAll();
      heapTypes.forEach((heapType, index) => {
        const def = defs[index]!;
        annotateStructNames(ctx.mod, heapType, { name: def.name, fields: def.fields });
        const typeRef = bin._BinaryenTypeFromHeapType(heapType, true);
        ctx.structHeapTypes.set(def.id, typeRef);
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
    } finally {
      builder.dispose();
    }
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

  buildRecursiveGroup(scc);
  const built = ctx.structHeapTypes.get(structuralId);
  if (!built) {
    throw new Error(`failed to cache runtime heap type for structural id ${structuralId}`);
  }
  return built;
};

const wasmStructFieldTypeFor = (typeId: TypeId, ctx: CodegenContext): binaryen.Type => {
  const structuralId = resolveStructuralTypeId(typeId, ctx);
  if (typeof structuralId === "number") {
    return ensureStructuralRuntimeType(structuralId, ctx);
  }
  return wasmTypeFor(typeId, ctx, new Set(), "signature");
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
  const desc = ctx.program.types.getTypeDesc(typeId);
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

const pickMethodMetadata = (
  metas: readonly FunctionMetadata[] | undefined,
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
          `codegen missing metadata for trait method impl ${implMethod}`,
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
