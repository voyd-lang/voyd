import binaryen from "binaryen";
import {
  arrayGet,
  arrayNew,
  arraySet,
  binaryenTypeToHeapType,
  defineArrayType,
  refCast,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  FunctionContext,
  LocalBindingLocal,
  StructuralFieldInfo,
  StructuralTypeInfo,
  TypeId,
} from "../context.js";
import { allocateTempLocal, loadLocalValue, storeLocalValue } from "../locals.js";
import {
  coerceValueToType,
  defaultFixedArrayElementValue,
  fixedArrayStorageElementType,
  initStructuralValue,
  liftFixedArrayElementValue,
  loadStructuralField,
  lowerFixedArrayElementValue,
  lowerValueForHeapField,
} from "../structural.js";
import {
  getFixedArrayWasmTypes,
  getInlineUnionLayout,
  getStructuralTypeInfo,
  shouldInlineUnionLayout,
  wasmTypeFor,
} from "../types.js";
import { coerceExprToWasmType } from "../wasm-type-coercions.js";
import { emitStringLiteral } from "../expressions/primitives.js";
import { ensureMsgPackFunctions } from "../effects/host-boundary/msgpack.js";
import { RTT_METADATA_SLOTS } from "../rtt/index.js";
import {
  compileOptionalNoneValue,
  compileOptionalSomeValue,
} from "../optionals.js";
import type {
  BoundaryArraySchema,
  BoundaryFieldSchema,
  BoundaryRecordSchema,
  BoundarySchema,
  BoundaryUnionSchema,
  BoundaryVariantSchema,
} from "./schema.js";
import { deriveBoundarySchema } from "./schema.js";

type BoundaryCodecState = {
  registry: Map<TypeId, BoundarySchema>;
  packHelpers: Map<TypeId, string>;
  activePackHelpers: Set<TypeId>;
  unpackHelpers: Map<TypeId, string>;
  activeUnpackHelpers: Set<TypeId>;
  ancestorStackType?: binaryen.Type;
};

const BOUNDARY_PACK_CYCLE_ERROR =
  "__voyd_boundary_error: cannot encode cyclic object graph or boundary object graph exceeds maximum depth";

export const packBoundaryValueAsMsgPack = ({
  value,
  schema,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundarySchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const state = createBoundaryCodecState(schema);
  const ancestorStack = emptyBoundaryAncestorStack({ ctx, state });
  return packBoundaryValueAsMsgPackInternal({
    value,
    schema,
    ctx,
    fnCtx,
    state,
    packAncestors: ancestorStack,
    packAncestorCount: ctx.mod.i32.const(0),
  });
};

const packBoundaryValueAsMsgPackInternal = ({
  value,
  schema,
  ctx,
  fnCtx,
  state,
  packAncestors,
  packAncestorCount,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundarySchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
  packAncestors: binaryen.ExpressionRef;
  packAncestorCount: binaryen.ExpressionRef;
}): binaryen.ExpressionRef => {
  if (schema.kind === "ref") {
    const helper = ensurePackHelper({ schema, ctx, state });
    return ctx.mod.call(
      helper,
      [value, packAncestors, packAncestorCount],
      wasmTypeFor(ensureMsgPackFunctions(ctx).msgPackTypeId, ctx),
    );
  }
  const msgpack = ensureMsgPackFunctions(ctx);
  const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);
  switch (schema.kind) {
    case "bool":
      return ctx.mod.call(msgpack.makeBool.wasmName, [value], msgPackType);
    case "i32":
      return ctx.mod.call(msgpack.makeI32.wasmName, [value], msgPackType);
    case "i64":
      return ctx.mod.call(msgpack.makeI64.wasmName, [value], msgPackType);
    case "f32":
      return ctx.mod.call(msgpack.makeF32.wasmName, [value], msgPackType);
    case "f64":
      return ctx.mod.call(msgpack.makeF64.wasmName, [value], msgPackType);
    case "void": {
      const valueType = binaryen.getExpressionType(value);
      const valueOp =
        valueType === binaryen.none || valueType === binaryen.unreachable
          ? value
          : ctx.mod.drop(value);
      return ctx.mod.block(
        null,
        [valueOp, ctx.mod.call(msgpack.makeNull.wasmName, [], msgPackType)],
        msgPackType,
      );
    }
    case "string":
      return ctx.mod.call(
        msgpack.makeString.wasmName,
        [
          coerceValueToType({
            value,
            actualType: schema.typeId,
            targetType: msgpack.makeString.paramTypeIds[0],
            ctx,
            fnCtx,
          }),
        ],
        msgPackType,
      );
    case "array":
      return packArray({
        value,
        schema,
        ctx,
        fnCtx,
        state,
        packAncestors,
        packAncestorCount,
      });
    case "record":
      return packRecord({
        value,
        schema,
        ctx,
        fnCtx,
        state,
        packAncestors,
        packAncestorCount,
      });
    case "union":
      return packUnion({
        value,
        schema,
        ctx,
        fnCtx,
        state,
        packAncestors,
        packAncestorCount,
      });
  }
};

export const unpackBoundaryValueFromMsgPack = ({
  value,
  schema,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundarySchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const state = createBoundaryCodecState(schema);
  return unpackBoundaryValueFromMsgPackInternal({ value, schema, ctx, fnCtx, state });
};

const unpackBoundaryValueFromMsgPackInternal = ({
  value,
  schema,
  ctx,
  fnCtx,
  state,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundarySchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
}): binaryen.ExpressionRef => {
  if (schema.kind === "ref") {
    const helper = ensureUnpackHelper({ schema, ctx, state });
    return ctx.mod.call(helper, [value], wasmTypeFor(schema.typeId, ctx));
  }
  const msgpack = ensureMsgPackFunctions(ctx);
  switch (schema.kind) {
    case "bool":
      return ctx.mod.call(msgpack.unpackBool.wasmName, [value], binaryen.i32);
    case "i32":
      return ctx.mod.call(msgpack.unpackI32.wasmName, [value], binaryen.i32);
    case "i64":
      return ctx.mod.call(msgpack.unpackI64.wasmName, [value], binaryen.i64);
    case "f32":
      return ctx.mod.call(msgpack.unpackF32.wasmName, [value], binaryen.f32);
    case "f64":
      return ctx.mod.call(msgpack.unpackF64.wasmName, [value], binaryen.f64);
    case "void":
      return ctx.mod.block(null, [ctx.mod.drop(value)], binaryen.none);
    case "string":
      return coerceValueToType({
        value: ctx.mod.call(
          msgpack.unpackString.wasmName,
          [value],
          wasmTypeFor(msgpack.unpackString.resultTypeId, ctx),
        ),
        actualType: msgpack.unpackString.resultTypeId,
        targetType: schema.typeId,
        ctx,
        fnCtx,
      });
    case "array":
      return unpackArray({ value, schema, ctx, fnCtx, state });
    case "record":
      return unpackRecord({ value, schema, ctx, fnCtx, state });
    case "union":
      return unpackUnion({ value, schema, ctx, fnCtx, state });
  }
};

const createBoundaryCodecState = (schema: BoundarySchema): BoundaryCodecState => {
  const registry = new Map<TypeId, BoundarySchema>();
  registerBoundarySchema({ schema, registry });
  return {
    registry,
    packHelpers: new Map(),
    activePackHelpers: new Set(),
    unpackHelpers: new Map(),
    activeUnpackHelpers: new Set(),
  };
};

const registerBoundarySchema = ({
  schema,
  registry,
}: {
  schema: BoundarySchema;
  registry: Map<TypeId, BoundarySchema>;
}): void => {
  if (schema.kind !== "ref" && !registry.has(schema.typeId)) {
    registry.set(schema.typeId, schema);
  }
  if (
    schema.kind === "array" ||
    schema.kind === "record" ||
    schema.kind === "union"
  ) {
    schema.aliases?.forEach((alias) => registry.set(alias, schema));
  }
  switch (schema.kind) {
    case "array":
      registerBoundarySchema({ schema: schema.element, registry });
      return;
    case "record":
      schema.fields.forEach((field) =>
        registerBoundarySchema({ schema: field.schema, registry }),
      );
      return;
    case "union":
      schema.variants.forEach((variant) =>
        variant.fields.forEach((field) =>
          registerBoundarySchema({ schema: field.schema, registry }),
        ),
      );
      return;
    default:
      return;
  }
};

const resolveSchemaRef = ({
  schema,
  ctx,
  state,
}: {
  schema: Extract<BoundarySchema, { kind: "ref" }>;
  ctx: CodegenContext;
  state: BoundaryCodecState;
}): BoundarySchema => {
  const existing = state.registry.get(schema.typeId);
  const resolved =
    existing ??
    deriveBoundarySchema({
      typeId: schema.typeId,
      ctx,
    });
  if (!existing) {
    registerBoundarySchema({
      schema: resolved,
      registry: state.registry,
    });
  }
  if (!resolved || resolved.kind === "ref") {
    throw new Error(`boundary schema has unresolved recursive ref ${schema.typeId}`);
  }
  return resolved;
};

const ensurePackHelper = ({
  schema,
  ctx,
  state,
}: {
  schema: Extract<BoundarySchema, { kind: "ref" }>;
  ctx: CodegenContext;
  state: BoundaryCodecState;
}): string => {
  const existing = state.packHelpers.get(schema.typeId);
  if (existing) return existing;

  const name = freshLabel(`__voyd_boundary_pack_${schema.typeId}`);
  state.packHelpers.set(schema.typeId, name);
  if (state.activePackHelpers.has(schema.typeId)) return name;

  state.activePackHelpers.add(schema.typeId);
  const msgpack = ensureMsgPackFunctions(ctx);
  const ancestorStackType = boundaryAncestorStackType({ ctx, state });
  const valueType = wasmTypeFor(schema.typeId, ctx);
  const params = binaryen.createType([valueType, ancestorStackType, binaryen.i32]);
  const result = wasmTypeFor(msgpack.msgPackTypeId, ctx);
  const locals: binaryen.Type[] = [];
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals,
    nextLocalIndex: binaryen.expandType(params).length,
    returnTypeId: msgpack.msgPackTypeId,
    effectful: false,
  };
  const nextAncestors = allocateTempLocal(ancestorStackType, fnCtx);
  const body = packBoundaryValueAsMsgPackInternal({
    value: ctx.mod.local.get(0, valueType),
    schema: resolveSchemaRef({ schema, ctx, state }),
    ctx,
    fnCtx,
    state,
    packAncestors: loadLocalValue(nextAncestors, ctx),
    packAncestorCount: ctx.mod.i32.add(ctx.mod.local.get(2, binaryen.i32), ctx.mod.i32.const(1)),
  });
  ctx.mod.addFunction(
    name,
    params,
    result,
    locals,
    ctx.mod.if(
      boundaryAncestorStackContains({
        value: ctx.mod.local.get(0, valueType),
        ancestors: ctx.mod.local.get(1, ancestorStackType),
        count: ctx.mod.local.get(2, binaryen.i32),
        ctx,
        fnCtx,
        state,
      }),
      boundaryPackCycleErrorMsgPack(ctx),
      ctx.mod.block(
        null,
        [
          storeLocalValue({
            binding: nextAncestors,
            value: boundaryAncestorStackWithValue({
              value: ctx.mod.local.get(0, valueType),
              ancestors: ctx.mod.local.get(1, ancestorStackType),
              count: ctx.mod.local.get(2, binaryen.i32),
              ctx,
              fnCtx,
              state,
            }),
            ctx,
            fnCtx,
          }),
          body,
        ],
        result,
      ),
    ),
  );
  state.activePackHelpers.delete(schema.typeId);
  return name;
};

const ensureUnpackHelper = ({
  schema,
  ctx,
  state,
}: {
  schema: Extract<BoundarySchema, { kind: "ref" }>;
  ctx: CodegenContext;
  state: BoundaryCodecState;
}): string => {
  const existing = state.unpackHelpers.get(schema.typeId);
  if (existing) return existing;

  const name = freshLabel(`__voyd_boundary_unpack_${schema.typeId}`);
  state.unpackHelpers.set(schema.typeId, name);
  if (state.activeUnpackHelpers.has(schema.typeId)) return name;

  state.activeUnpackHelpers.add(schema.typeId);
  const msgpack = ensureMsgPackFunctions(ctx);
  const params = binaryen.createType([wasmTypeFor(msgpack.msgPackTypeId, ctx)]);
  const result = wasmTypeFor(schema.typeId, ctx);
  const locals: binaryen.Type[] = [];
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals,
    nextLocalIndex: binaryen.expandType(params).length,
    returnTypeId: schema.typeId,
    effectful: false,
  };
  const body = unpackBoundaryValueFromMsgPackInternal({
    value: ctx.mod.local.get(0, wasmTypeFor(msgpack.msgPackTypeId, ctx)),
    schema: resolveSchemaRef({ schema, ctx, state }),
    ctx,
    fnCtx,
    state,
  });
  ctx.mod.addFunction(name, params, result, locals, body);
  state.activeUnpackHelpers.delete(schema.typeId);
  return name;
};

const boundaryAncestorStackType = ({
  ctx,
  state,
}: {
  ctx: CodegenContext;
  state: BoundaryCodecState;
}): binaryen.Type => {
  if (typeof state.ancestorStackType === "number") {
    return state.ancestorStackType;
  }
  state.ancestorStackType = defineArrayType(
    ctx.mod,
    binaryen.eqref,
    true,
    "__voyd_boundary_ancestor_stack",
  );
  return state.ancestorStackType;
};

const emptyBoundaryAncestorStack = ({
  ctx,
  state,
}: {
  ctx: CodegenContext;
  state: BoundaryCodecState;
}): binaryen.ExpressionRef => {
  const stackType = boundaryAncestorStackType({ ctx, state });
  return arrayNew(
    ctx.mod,
    binaryenTypeToHeapType(stackType),
    ctx.mod.i32.const(0),
    ctx.mod.ref.null(binaryen.eqref),
  );
};

const boundaryAncestorStackContains = ({
  value,
  ancestors,
  count,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  ancestors: binaryen.ExpressionRef;
  count: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
}): binaryen.ExpressionRef => {
  const index = allocateTempLocal(binaryen.i32, fnCtx);
  const found = allocateTempLocal(binaryen.i32, fnCtx);
  const indexRef = () => loadLocalValue(index, ctx);
  const foundRef = () => loadLocalValue(found, ctx);
  const loopLabel = freshLabel("boundary_ancestor_scan");
  return ctx.mod.block(
    null,
    [
      storeLocalValue({
        binding: index,
        value: ctx.mod.i32.const(0),
        ctx,
        fnCtx,
      }),
      storeLocalValue({
        binding: found,
        value: ctx.mod.i32.const(0),
        ctx,
        fnCtx,
      }),
      ctx.mod.loop(
        loopLabel,
        ctx.mod.if(
          ctx.mod.i32.and(
            ctx.mod.i32.lt_s(indexRef(), count),
            ctx.mod.i32.eq(foundRef(), ctx.mod.i32.const(0)),
          ),
          ctx.mod.block(null, [
            ctx.mod.if(
              ctx.mod.ref.eq(
                arrayGet(ctx.mod, ancestors, indexRef(), binaryen.eqref, false),
                value,
              ),
              storeLocalValue({
                binding: found,
                value: ctx.mod.i32.const(1),
                ctx,
                fnCtx,
              }),
            ),
            storeLocalValue({
              binding: index,
              value: ctx.mod.i32.add(indexRef(), ctx.mod.i32.const(1)),
              ctx,
              fnCtx,
            }),
            ctx.mod.br(loopLabel),
          ]),
        ),
      ),
      foundRef(),
    ],
    binaryen.i32,
  );
};

const boundaryAncestorStackWithValue = ({
  value,
  ancestors,
  count,
  ctx,
  fnCtx,
  state,
}: {
  value: binaryen.ExpressionRef;
  ancestors: binaryen.ExpressionRef;
  count: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
}): binaryen.ExpressionRef => {
  const stackType = boundaryAncestorStackType({ ctx, state });
  const next = allocateTempLocal(stackType, fnCtx);
  const index = allocateTempLocal(binaryen.i32, fnCtx);
  const nextRef = () => loadLocalValue(next, ctx);
  const indexRef = () => loadLocalValue(index, ctx);
  const loopLabel = freshLabel("boundary_ancestor_copy");
  return ctx.mod.block(
    null,
    [
      storeLocalValue({
        binding: next,
        value: arrayNew(
          ctx.mod,
          binaryenTypeToHeapType(stackType),
          ctx.mod.i32.add(count, ctx.mod.i32.const(1)),
          ctx.mod.ref.null(binaryen.eqref),
        ),
        ctx,
        fnCtx,
      }),
      storeLocalValue({
        binding: index,
        value: ctx.mod.i32.const(0),
        ctx,
        fnCtx,
      }),
      ctx.mod.loop(
        loopLabel,
        ctx.mod.if(
          ctx.mod.i32.lt_s(indexRef(), count),
          ctx.mod.block(null, [
            arraySet(
              ctx.mod,
              nextRef(),
              indexRef(),
              arrayGet(ctx.mod, ancestors, indexRef(), binaryen.eqref, false),
            ),
            storeLocalValue({
              binding: index,
              value: ctx.mod.i32.add(indexRef(), ctx.mod.i32.const(1)),
              ctx,
              fnCtx,
            }),
            ctx.mod.br(loopLabel),
          ]),
        ),
      ),
      arraySet(ctx.mod, nextRef(), count, value),
      nextRef(),
    ],
    stackType,
  );
};

const packArray = ({
  value,
  schema,
  ctx,
  fnCtx,
  state,
  packAncestors,
  packAncestorCount,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryArraySchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
  packAncestors: binaryen.ExpressionRef;
  packAncestorCount: binaryen.ExpressionRef;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);
  const info = requiredStructuralInfo(schema.typeId, ctx);
  const storageField = requiredField(info.fieldMap, "storage", schema.typeId);
  const countField = requiredField(info.fieldMap, "count", schema.typeId);
  const source = allocateTempLocal(wasmTypeFor(schema.typeId, ctx), fnCtx, schema.typeId, ctx);
  const count = allocateTempLocal(binaryen.i32, fnCtx);
  const index = allocateTempLocal(binaryen.i32, fnCtx);
  const out = allocateTempLocal(msgpack.arrayWithCapacity.resultType, fnCtx);
  const sourceRef = () => loadLocalValue(source, ctx);
  const countRef = () => loadLocalValue(count, ctx);
  const indexRef = () => loadLocalValue(index, ctx);
  const outRef = () => loadLocalValue(out, ctx);
  const storageRef = () =>
    loadStructuralField({
      structInfo: info,
      field: storageField,
      pointer: sourceRef,
      ctx,
    });
  const loopLabel = freshLabel("boundary_array_pack");

  return ctx.mod.block(
    null,
    [
      storeLocalValue({ binding: source, value, ctx, fnCtx }),
      storeLocalValue({
        binding: count,
        value: loadStructuralField({
          structInfo: info,
          field: countField,
          pointer: sourceRef,
          ctx,
        }),
        ctx,
        fnCtx,
      }),
      storeLocalValue({
        binding: out,
        value: ctx.mod.call(msgpack.arrayWithCapacity.wasmName, [countRef()], out.type),
        ctx,
        fnCtx,
      }),
      storeLocalValue({
        binding: index,
        value: ctx.mod.i32.const(0),
        ctx,
        fnCtx,
      }),
      ctx.mod.loop(
        loopLabel,
        ctx.mod.if(
          ctx.mod.i32.lt_s(indexRef(), countRef()),
          ctx.mod.block(null, [
            storeLocalValue({
              binding: out,
              value: ctx.mod.call(
                msgpack.arrayPush.wasmName,
                [
                  outRef(),
                  packBoundaryValueAsMsgPackInternal({
                    value: fixedArrayGet({
                      array: storageRef(),
                      elementTypeId: schema.elementTypeId,
                      index: indexRef(),
                      ctx,
                      fnCtx,
                    }),
                    schema: schema.element,
                    ctx,
                    fnCtx,
                    state,
                    packAncestors,
                    packAncestorCount,
                  }),
                ],
                out.type,
              ),
              ctx,
              fnCtx,
            }),
            storeLocalValue({
              binding: index,
              value: ctx.mod.i32.add(indexRef(), ctx.mod.i32.const(1)),
              ctx,
              fnCtx,
            }),
            ctx.mod.br(loopLabel),
          ]),
        ),
      ),
      ctx.mod.call(msgpack.makeArray.wasmName, [outRef()], msgPackType),
    ],
    msgPackType,
  );
};

const unpackArray = ({
  value,
  schema,
  ctx,
  fnCtx,
  state,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryArraySchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);
  const info = requiredStructuralInfo(schema.typeId, ctx);
  const storageField = requiredField(info.fieldMap, "storage", schema.typeId);
  const countField = requiredField(info.fieldMap, "count", schema.typeId);
  const ownersField = requiredField(info.fieldMap, "owners", schema.typeId);
  const sourceArray = allocateTempLocal(msgpack.unpackArray.resultType, fnCtx);
  const sourceStorage = allocateTempLocal(msgpack.arrayRawStorage.resultType, fnCtx);
  const count = allocateTempLocal(binaryen.i32, fnCtx);
  const index = allocateTempLocal(binaryen.i32, fnCtx);
  const targetStorage = allocateTempLocal(storageField.wasmType, fnCtx, storageField.typeId, ctx);
  const sourceStorageRef = () => loadLocalValue(sourceStorage, ctx);
  const countRef = () => loadLocalValue(count, ctx);
  const indexRef = () => loadLocalValue(index, ctx);
  const targetStorageRef = () => loadLocalValue(targetStorage, ctx);
  const loopLabel = freshLabel("boundary_array_unpack");

  const fieldValueFor = (field: StructuralFieldInfo): binaryen.ExpressionRef => {
    if (field.name === "storage") {
      return lowerValueForHeapField({
        value: targetStorageRef(),
        typeId: storageField.typeId,
        targetType: storageField.heapWasmType,
        ctx,
        fnCtx,
      });
    }
    if (field.name === "count") {
      return lowerValueForHeapField({
        value: countRef(),
        typeId: countField.typeId,
        targetType: countField.heapWasmType,
        ctx,
        fnCtx,
      });
    }
    if (field.name === "owners") {
      return lowerValueForHeapField({
        value: freshArrayOwners({ typeId: ownersField.typeId, ctx, fnCtx }),
        typeId: ownersField.typeId,
        targetType: ownersField.heapWasmType,
        ctx,
        fnCtx,
      });
    }
    throw new Error(`unexpected Array boundary field ${field.name}`);
  };

  const arrayValue = initStructuralValue({
    structInfo: info,
    fieldValues: info.fields.map(fieldValueFor),
    ctx,
  });

  return ctx.mod.block(
    null,
    [
      storeLocalValue({
        binding: sourceArray,
        value: ctx.mod.call(msgpack.unpackArray.wasmName, [value], sourceArray.type),
        ctx,
        fnCtx,
      }),
      storeLocalValue({
        binding: count,
        value: ctx.mod.call(msgpack.arrayLength.wasmName, [loadLocalValue(sourceArray, ctx)], binaryen.i32),
        ctx,
        fnCtx,
      }),
      storeLocalValue({
        binding: sourceStorage,
        value: ctx.mod.call(
          msgpack.arrayRawStorage.wasmName,
          [loadLocalValue(sourceArray, ctx)],
          sourceStorage.type,
        ),
        ctx,
        fnCtx,
      }),
      storeLocalValue({
        binding: targetStorage,
        value: fixedArrayNew({
          arrayTypeId: storageField.typeId,
          elementTypeId: schema.elementTypeId,
          length: countRef(),
          ctx,
        }),
        ctx,
        fnCtx,
      }),
      storeLocalValue({
        binding: index,
        value: ctx.mod.i32.const(0),
        ctx,
        fnCtx,
      }),
      ctx.mod.loop(
        loopLabel,
        ctx.mod.if(
          ctx.mod.i32.lt_s(indexRef(), countRef()),
          ctx.mod.block(null, [
            fixedArraySet({
              array: targetStorageRef(),
              elementTypeId: schema.elementTypeId,
              index: indexRef(),
              value: unpackBoundaryValueFromMsgPackInternal({
                value: arrayGet(ctx.mod, sourceStorageRef(), indexRef(), msgPackType, false),
                schema: schema.element,
                ctx,
                fnCtx,
                state,
              }),
              ctx,
              fnCtx,
            }),
            storeLocalValue({
              binding: index,
              value: ctx.mod.i32.add(indexRef(), ctx.mod.i32.const(1)),
              ctx,
              fnCtx,
            }),
            ctx.mod.br(loopLabel),
          ]),
        ),
      ),
      arrayValue,
    ],
    wasmTypeFor(schema.typeId, ctx),
  );
};

const packRecord = ({
  value,
  schema,
  ctx,
  fnCtx,
  state,
  packAncestors,
  packAncestorCount,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryRecordSchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
  packAncestors: binaryen.ExpressionRef;
  packAncestorCount: binaryen.ExpressionRef;
}): binaryen.ExpressionRef =>
  packRecordMap({
    value,
    typeId: schema.typeId,
    fields: schema.fields,
    tag: schema.tag,
    ctx,
    fnCtx,
    state,
    packAncestors,
    packAncestorCount,
  });

const unpackRecord = ({
  value,
  schema,
  ctx,
  fnCtx,
  state,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryRecordSchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  const map = allocateTempLocal(msgpack.unpackMap.resultType, fnCtx);
  return ctx.mod.block(
    null,
    [
      storeLocalValue({
        binding: map,
        value: ctx.mod.call(msgpack.unpackMap.wasmName, [value], map.type),
        ctx,
        fnCtx,
      }),
      unpackRecordFromMap({
        map,
        typeId: schema.typeId,
        fields: schema.fields,
        ctx,
        fnCtx,
        state,
      }),
    ],
    wasmTypeFor(schema.typeId, ctx),
  );
};

const packUnion = ({
  value,
  schema,
  ctx,
  fnCtx,
  state,
  packAncestors,
  packAncestorCount,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryUnionSchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
  packAncestors: binaryen.ExpressionRef;
  packAncestorCount: binaryen.ExpressionRef;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);
  const source = allocateTempLocal(wasmTypeFor(schema.typeId, ctx), fnCtx, schema.typeId, ctx);
  const sourceRef = () => loadLocalValue(source, ctx);
  const encodeVariant = (variant: BoundaryVariantSchema): binaryen.ExpressionRef =>
    packRecordMap({
      value: coerceValueToType({
        value: sourceRef(),
        actualType: schema.typeId,
        targetType: variant.typeId,
        ctx,
        fnCtx,
      }),
      typeId: variant.typeId,
      fields: variant.fields,
      tag: variant.name,
      ctx,
      fnCtx,
      state,
      packAncestors,
      packAncestorCount,
    });
  const branches = schema.variants.reduceRight<binaryen.ExpressionRef>(
    (fallback, variant) =>
      ctx.mod.if(
        variantMatches({
          unionValue: sourceRef(),
          unionTypeId: schema.typeId,
          variant,
          ctx,
        }),
        encodeVariant(variant),
        fallback,
      ),
    ctx.mod.block(null, [ctx.mod.unreachable()], msgPackType),
  );
  return ctx.mod.block(
    null,
    [storeLocalValue({ binding: source, value, ctx, fnCtx }), branches],
    msgPackType,
  );
};

const unpackUnion = ({
  value,
  schema,
  ctx,
  fnCtx,
  state,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryUnionSchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  const map = allocateTempLocal(msgpack.unpackMap.resultType, fnCtx);
  const mapRef = () => loadLocalValue(map, ctx);
  const decodeVariant = (variant: BoundaryVariantSchema): binaryen.ExpressionRef =>
    coerceValueToType({
      value: unpackRecordFromMap({
        map,
        typeId: variant.typeId,
        fields: variant.fields,
        ctx,
        fnCtx,
        state,
      }),
      actualType: variant.typeId,
      targetType: schema.typeId,
      ctx,
      fnCtx,
    });
  const branches = schema.variants.reduceRight<binaryen.ExpressionRef>(
    (fallback, variant) =>
      ctx.mod.if(
        ctx.mod.call(
          msgpack.mapTagIs.wasmName,
          [mapRef(), stringValue(variant.name, ctx)],
          binaryen.i32,
        ),
        decodeVariant(variant),
        fallback,
      ),
    ctx.mod.block(null, [ctx.mod.unreachable()], wasmTypeFor(schema.typeId, ctx)),
  );

  return ctx.mod.block(
    null,
    [
      storeLocalValue({
        binding: map,
        value: ctx.mod.call(msgpack.unpackMap.wasmName, [value], map.type),
        ctx,
        fnCtx,
      }),
      branches,
    ],
    wasmTypeFor(schema.typeId, ctx),
  );
};

const packRecordMap = ({
  value,
  typeId,
  fields,
  tag,
  ctx,
  fnCtx,
  state,
  packAncestors,
  packAncestorCount,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  fields: readonly BoundaryFieldSchema[];
  tag?: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
  packAncestors: binaryen.ExpressionRef;
  packAncestorCount: binaryen.ExpressionRef;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);
  const info = requiredStructuralInfo(typeId, ctx);
  const source = allocateTempLocal(wasmTypeFor(typeId, ctx), fnCtx, typeId, ctx);
  const map = allocateTempLocal(msgpack.mapNew.resultType, fnCtx);
  const sourceRef = () => loadLocalValue(source, ctx);
  const mapRef = () => loadLocalValue(map, ctx);
  const ops: binaryen.ExpressionRef[] = [
    storeLocalValue({ binding: source, value, ctx, fnCtx }),
    storeLocalValue({
      binding: map,
      value: ctx.mod.call(msgpack.mapNew.wasmName, [], map.type),
      ctx,
      fnCtx,
    }),
  ];
  if (tag) {
    ops.push(
      storeLocalValue({
        binding: map,
        value: ctx.mod.call(
          msgpack.mapSet.wasmName,
          [mapRef(), stringValue("$variant", ctx), stringMsgPack(tag, ctx)],
          map.type,
        ),
        ctx,
        fnCtx,
      }),
    );
  }
  fields.forEach((field) => {
    const structuralField = requiredField(info.fieldMap, field.name, typeId);
    const fieldValue = loadStructuralField({
      structInfo: info,
      field: structuralField,
      pointer: sourceRef,
      ctx,
    });
    ops.push(
      field.optional
        ? packOptionalRecordField({
            map,
            field,
            value: fieldValue,
            optionalTypeId: structuralField.typeId,
            ctx,
            fnCtx,
            state,
            packAncestors,
            packAncestorCount,
          })
        : storeLocalValue({
            binding: map,
            value: ctx.mod.call(
              msgpack.mapSet.wasmName,
              [
                mapRef(),
                stringValue(field.name, ctx),
                packBoundaryValueAsMsgPackInternal({
                  value: fieldValue,
                  schema: field.schema,
                  ctx,
                  fnCtx,
                  state,
                  packAncestors,
                  packAncestorCount,
                }),
              ],
              map.type,
            ),
            ctx,
            fnCtx,
          }),
    );
  });
  ops.push(ctx.mod.call(msgpack.makeMap.wasmName, [mapRef()], msgPackType));
  return ctx.mod.block(null, ops, msgPackType);
};

const unpackRecordFromMap = ({
  map,
  typeId,
  fields,
  ctx,
  fnCtx,
  state,
}: {
  map: LocalBindingLocal;
  typeId: TypeId;
  fields: readonly BoundaryFieldSchema[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  const info = requiredStructuralInfo(typeId, ctx);
  const fieldValues = info.fields.map((field) => {
    const schemaField = fields.find((candidate) => candidate.name === field.name);
    if (!schemaField) {
      throw new Error(`boundary schema missing field ${field.name}`);
    }
    const value = schemaField.optional
      ? unpackOptionalRecordField({
          map,
          field: schemaField,
          optionalTypeId: field.typeId,
          ctx,
          fnCtx,
          state,
        })
      : unpackBoundaryValueFromMsgPackInternal({
          value: ctx.mod.call(
            msgpack.mapGet.wasmName,
            [loadLocalValue(map, ctx), stringValue(field.name, ctx)],
            wasmTypeFor(msgpack.msgPackTypeId, ctx),
          ),
          schema: schemaField.schema,
          ctx,
          fnCtx,
          state,
        });
    return lowerFieldValueForInit({
      structInfo: info,
      field,
      value,
      ctx,
      fnCtx,
    });
  });
  return initStructuralValue({ structInfo: info, fieldValues, ctx });
};

const packOptionalRecordField = ({
  map,
  field,
  value,
  optionalTypeId,
  ctx,
  fnCtx,
  state,
  packAncestors,
  packAncestorCount,
}: {
  map: LocalBindingLocal;
  field: BoundaryFieldSchema;
  value: binaryen.ExpressionRef;
  optionalTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
  packAncestors: binaryen.ExpressionRef;
  packAncestorCount: binaryen.ExpressionRef;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  const optional = allocateTempLocal(
    wasmTypeFor(optionalTypeId, ctx),
    fnCtx,
    optionalTypeId,
    ctx,
  );
  const optionalRef = () => loadLocalValue(optional, ctx);
  const [isSome, someValue] = unpackOptionalSomePayload({
    value: optionalRef,
    optionalTypeId,
    ctx,
    fnCtx,
  });
  const setField = storeLocalValue({
    binding: map,
    value: ctx.mod.call(
      msgpack.mapSet.wasmName,
      [
        loadLocalValue(map, ctx),
        stringValue(field.name, ctx),
        packBoundaryValueAsMsgPackInternal({
          value: someValue,
          schema: field.schema,
          ctx,
          fnCtx,
          state,
          packAncestors,
          packAncestorCount,
        }),
      ],
      map.type,
    ),
    ctx,
    fnCtx,
  });
  return ctx.mod.block(
    null,
    [
      storeLocalValue({ binding: optional, value, ctx, fnCtx }),
      ctx.mod.if(isSome, setField),
    ],
  );
};

const unpackOptionalRecordField = ({
  map,
  field,
  optionalTypeId,
  ctx,
  fnCtx,
  state,
}: {
  map: LocalBindingLocal;
  field: BoundaryFieldSchema;
  optionalTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  state: BoundaryCodecState;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  return ctx.mod.if(
    ctx.mod.call(
      msgpack.mapHas.wasmName,
      [loadLocalValue(map, ctx), stringValue(field.name, ctx)],
      binaryen.i32,
    ),
    compileOptionalSomeValue({
      targetTypeId: optionalTypeId,
      value: unpackBoundaryValueFromMsgPackInternal({
        value: ctx.mod.call(
          msgpack.mapGet.wasmName,
          [loadLocalValue(map, ctx), stringValue(field.name, ctx)],
          wasmTypeFor(msgpack.msgPackTypeId, ctx),
        ),
        schema: field.schema,
        ctx,
        fnCtx,
        state,
      }),
      valueTypeId: field.typeId,
      ctx,
      fnCtx,
    }),
    compileOptionalNoneValue({
      targetTypeId: optionalTypeId,
      ctx,
      fnCtx,
    }),
  );
};

const unpackOptionalSomePayload = ({
  value,
  optionalTypeId,
  ctx,
  fnCtx,
}: {
  value: () => binaryen.ExpressionRef;
  optionalTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): readonly [binaryen.ExpressionRef, binaryen.ExpressionRef] => {
  const optionalInfo = ctx.program.optionals.getOptionalInfo(
    ctx.moduleId,
    optionalTypeId,
  );
  if (!optionalInfo) {
    throw new Error("optional boundary field requires an Optional type");
  }
  const someInfo = requiredStructuralInfo(optionalInfo.someType, ctx);
  const someField = someInfo.fields[0];
  if (!someField || someInfo.fields.length !== 1) {
    throw new Error("optional boundary Some type must declare one field");
  }

  const someVariant: BoundaryVariantSchema = {
    name: "Some",
    typeId: optionalInfo.someType,
    fields: [],
  };
  const isSome = variantMatches({
    unionValue: value(),
    unionTypeId: optionalTypeId,
    variant: someVariant,
    ctx,
  });

  if (shouldInlineUnionLayout(optionalTypeId, ctx)) {
    const layout = getInlineUnionLayout(optionalTypeId, ctx);
    const someLayout = layout.members.find(
      (member) => member.typeId === optionalInfo.someType,
    );
    if (!someLayout) {
      throw new Error("optional boundary layout is missing Some member");
    }
    const abiTypes = binaryen.expandType(binaryen.getExpressionType(value()));
    const payloadValues = someLayout.abiTypes.map((_, index) =>
      abiTypes.length === 1
        ? value()
        : ctx.mod.tuple.extract(value(), someLayout.abiStart + index),
    );
    const payload =
      payloadValues.length === 0
        ? ctx.mod.nop()
        : payloadValues.length === 1
          ? payloadValues[0]!
          : ctx.mod.tuple.make(payloadValues);
    return [
      isSome,
      coerceValueToType({
        value: payload,
        actualType: someField.typeId,
        targetType: optionalInfo.innerType,
        ctx,
        fnCtx,
      }),
    ];
  }

  return [
    isSome,
    coerceValueToType({
      value: loadStructuralField({
        structInfo: someInfo,
        field: someField,
        pointer: () => refCast(ctx.mod, value(), someInfo.runtimeType),
        ctx,
      }),
      actualType: someField.typeId,
      targetType: optionalInfo.innerType,
      ctx,
      fnCtx,
    }),
  ];
};

const variantMatches = ({
  unionValue,
  unionTypeId,
  variant,
  ctx,
}: {
  unionValue: binaryen.ExpressionRef;
  unionTypeId: TypeId;
  variant: BoundaryVariantSchema;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (shouldInlineUnionLayout(unionTypeId, ctx)) {
    const layout = getInlineUnionLayout(unionTypeId, ctx);
    const member = layout.members.find((candidate) => candidate.typeId === variant.typeId);
    if (!member) {
      throw new Error(`missing inline union member for ${variant.name}`);
    }
    const abiTypes = binaryen.expandType(binaryen.getExpressionType(unionValue));
    const tagValue =
      abiTypes.length <= 1 ? unionValue : ctx.mod.tuple.extract(unionValue, 0);
    return ctx.mod.i32.eq(tagValue, ctx.mod.i32.const(member.tag));
  }

  const info = requiredStructuralInfo(variant.typeId, ctx);
  return ctx.mod.call(
    "__has_type",
    [
      ctx.mod.i32.const(info.runtimeTypeId),
      structGetFieldValue({
        mod: ctx.mod,
        fieldType: ctx.rtt.extensionHelpers.i32Array,
        fieldIndex: RTT_METADATA_SLOTS.ANCESTORS,
        exprRef: coerceExprToWasmType({
          expr: unionValue,
          targetType: ctx.rtt.baseType,
          ctx,
        }),
      }),
    ],
    binaryen.i32,
  );
};

const fixedArrayNew = ({
  arrayTypeId,
  elementTypeId,
  length,
  ctx,
}: {
  arrayTypeId: TypeId;
  elementTypeId: TypeId;
  length: binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const wasmTypes = getFixedArrayWasmTypes(arrayTypeId, ctx);
  return arrayNew(
    ctx.mod,
    wasmTypes.heapType,
    length,
    defaultFixedArrayElementValue({ typeId: elementTypeId, ctx }),
  );
};

const fixedArrayGet = ({
  array,
  elementTypeId,
  index,
  ctx,
  fnCtx,
}: {
  array: binaryen.ExpressionRef;
  elementTypeId: TypeId;
  index: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  return liftFixedArrayElementValue({
    value: arrayGet(
      ctx.mod,
      array,
      index,
      fixedArrayStorageElementType({ typeId: elementTypeId, ctx }),
      false,
    ),
    typeId: elementTypeId,
    ctx,
    fnCtx,
  });
};

const fixedArraySet = ({
  array,
  elementTypeId,
  index,
  value,
  ctx,
  fnCtx,
}: {
  array: binaryen.ExpressionRef;
  elementTypeId: TypeId;
  index: binaryen.ExpressionRef;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  return arraySet(
    ctx.mod,
    array,
    index,
    lowerFixedArrayElementValue({
      value,
      typeId: elementTypeId,
      ctx,
      fnCtx,
    }),
  );
};

const lowerFieldValueForInit = ({
  structInfo,
  field,
  value,
  ctx,
  fnCtx,
}: {
  structInfo: StructuralTypeInfo;
  field: StructuralFieldInfo;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef =>
  structInfo.layoutKind === "value-object"
    ? coerceExprToWasmType({
        expr: value,
        targetType: field.wasmType,
        ctx,
      })
    : lowerValueForHeapField({
        value,
        typeId: field.typeId,
        targetType: field.heapWasmType,
        ctx,
        fnCtx,
      });

const freshArrayOwners = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const info = requiredStructuralInfo(typeId, ctx);
  const refs = requiredField(info.fieldMap, "refs", typeId);
  return initStructuralValue({
    structInfo: info,
    fieldValues: [
      coerceExprToWasmType({
        expr: ctx.mod.i32.const(1),
        targetType: refs.heapWasmType,
        ctx,
      }),
    ],
    ctx,
  });
};

const requiredStructuralInfo = (typeId: TypeId, ctx: CodegenContext) => {
  const info = getStructuralTypeInfo(typeId, ctx);
  if (!info) {
    throw new Error(`missing boundary structural info for type ${typeId}`);
  }
  return info;
};

const requiredField = (
  fields: ReadonlyMap<string, StructuralFieldInfo>,
  name: string,
  typeId: TypeId,
): StructuralFieldInfo => {
  const field = fields.get(name);
  if (!field) {
    throw new Error(`missing boundary field ${name} on ${typeId}`);
  }
  return field;
};

const stringValue = (value: string, ctx: CodegenContext): binaryen.ExpressionRef =>
  emitStringLiteral(value, ctx);

const stringMsgPack = (value: string, ctx: CodegenContext): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  return ctx.mod.call(
    msgpack.makeString.wasmName,
    [stringValue(value, ctx)],
    wasmTypeFor(msgpack.msgPackTypeId, ctx),
  );
};

const boundaryPackCycleErrorMsgPack = (ctx: CodegenContext): binaryen.ExpressionRef =>
  stringMsgPack(BOUNDARY_PACK_CYCLE_ERROR, ctx);

let labelCounter = 0;

const freshLabel = (prefix: string): string => `${prefix}_${labelCounter++}`;
