import binaryen from "binaryen";
import {
  arrayGet,
  arrayNew,
  arraySet,
  binaryenTypeToHeapType,
  initStruct,
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
  initStructuralValue,
  liftHeapValueToInline,
  loadStructuralField,
  lowerValueForHeapField,
  makeInlineValue,
} from "../structural.js";
import { captureMultivalueLanes } from "../multivalue.js";
import {
  getFixedArrayWasmTypes,
  getInlineUnionLayout,
  getStructuralTypeInfo,
  shouldInlineUnionLayout,
  wasmHeapFieldTypeFor,
  wasmTypeFor,
} from "../types.js";
import { coerceExprToWasmType } from "../wasm-type-coercions.js";
import { emitStringLiteral } from "../expressions/primitives.js";
import { ensureMsgPackFunctions } from "../effects/host-boundary/msgpack.js";
import { RTT_METADATA_SLOTS } from "../rtt/index.js";
import type {
  BoundaryArraySchema,
  BoundaryFieldSchema,
  BoundaryRecordSchema,
  BoundarySchema,
  BoundaryUnionSchema,
  BoundaryVariantSchema,
} from "./schema.js";

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
      return packArray({ value, schema, ctx, fnCtx });
    case "record":
      return packRecord({ value, schema, ctx, fnCtx });
    case "union":
      return packUnion({ value, schema, ctx, fnCtx });
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
      return unpackArray({ value, schema, ctx, fnCtx });
    case "record":
      return unpackRecord({ value, schema, ctx, fnCtx });
    case "union":
      return unpackUnion({ value, schema, ctx, fnCtx });
  }
};

const packArray = ({
  value,
  schema,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryArraySchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
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
                  packBoundaryValueAsMsgPack({
                    value: fixedArrayGet({
                      array: storageRef(),
                      arrayTypeId: storageField.typeId,
                      elementTypeId: schema.elementTypeId,
                      index: indexRef(),
                      ctx,
                      fnCtx,
                    }),
                    schema: schema.element,
                    ctx,
                    fnCtx,
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
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryArraySchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
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
              arrayTypeId: storageField.typeId,
              elementTypeId: schema.elementTypeId,
              index: indexRef(),
              value: unpackBoundaryValueFromMsgPack({
                value: arrayGet(ctx.mod, sourceStorageRef(), indexRef(), msgPackType, false),
                schema: schema.element,
                ctx,
                fnCtx,
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
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryRecordSchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef =>
  packRecordMap({
    value,
    typeId: schema.typeId,
    fields: schema.fields,
    tag: schema.tag,
    ctx,
    fnCtx,
  });

const unpackRecord = ({
  value,
  schema,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryRecordSchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
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
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryUnionSchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
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
}: {
  value: binaryen.ExpressionRef;
  schema: BoundaryUnionSchema;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
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
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  fields: readonly BoundaryFieldSchema[];
  tag?: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
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
    ops.push(
      storeLocalValue({
        binding: map,
        value: ctx.mod.call(
          msgpack.mapSet.wasmName,
          [
            mapRef(),
            stringValue(field.name, ctx),
            packBoundaryValueAsMsgPack({
              value: loadStructuralField({
                structInfo: info,
                field: structuralField,
                pointer: sourceRef,
                ctx,
              }),
              schema: field.schema,
              ctx,
              fnCtx,
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
}: {
  map: LocalBindingLocal;
  typeId: TypeId;
  fields: readonly BoundaryFieldSchema[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  const info = requiredStructuralInfo(typeId, ctx);
  const fieldValues = info.fields.map((field) => {
    const schemaField = fields.find((candidate) => candidate.name === field.name);
    if (!schemaField) {
      throw new Error(`boundary schema missing field ${field.name}`);
    }
    return lowerFieldValueForInit({
      structInfo: info,
      field,
      value: unpackBoundaryValueFromMsgPack({
        value: ctx.mod.call(
          msgpack.mapGet.wasmName,
          [loadLocalValue(map, ctx), stringValue(field.name, ctx)],
          wasmTypeFor(msgpack.msgPackTypeId, ctx),
        ),
        schema: schemaField.schema,
        ctx,
        fnCtx,
      }),
      ctx,
      fnCtx,
    });
  });
  return initStructuralValue({ structInfo: info, fieldValues, ctx });
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
  if (wasmTypes.kind === "inline-aggregate") {
    const laneTypes = wasmTypes.laneTypes ?? [];
    const laneArrayTypes = wasmTypes.laneArrayTypes ?? [];
    return initStruct(ctx.mod, wasmTypes.type, [
      length,
      ...laneTypes.map((laneType, index) =>
        arrayNew(
          ctx.mod,
          binaryenTypeToHeapType(laneArrayTypes[index]!),
          length,
          defaultValueForWasmType(laneType, ctx),
        ),
      ),
    ]);
  }
  const elementType = wasmHeapFieldTypeFor(elementTypeId, ctx, new Set(), "runtime");
  return arrayNew(
    ctx.mod,
    wasmTypes.heapType,
    length,
    defaultValueForWasmType(elementType, ctx),
  );
};

const fixedArrayGet = ({
  array,
  arrayTypeId,
  elementTypeId,
  index,
  ctx,
}: {
  array: binaryen.ExpressionRef;
  arrayTypeId: TypeId;
  elementTypeId: TypeId;
  index: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const wasmTypes = getFixedArrayWasmTypes(arrayTypeId, ctx);
  if (wasmTypes.kind === "inline-aggregate") {
    const laneTypes = wasmTypes.laneTypes ?? [];
    const laneArrayTypes = wasmTypes.laneArrayTypes ?? [];
    const lanes = laneTypes.map((laneType, laneIndex) =>
      arrayGet(
        ctx.mod,
        structGetFieldValue({
          mod: ctx.mod,
          fieldIndex: laneIndex + 1,
          fieldType: laneArrayTypes[laneIndex]!,
          exprRef: array,
        }),
        index,
        laneType,
        false,
      ),
    );
    return makeInlineValue({ values: lanes, ctx });
  }
  const elementType = wasmHeapFieldTypeFor(elementTypeId, ctx, new Set(), "runtime");
  return liftHeapValueToInline({
    value: arrayGet(ctx.mod, array, index, elementType, false),
    typeId: elementTypeId,
    ctx,
  });
};

const fixedArraySet = ({
  array,
  arrayTypeId,
  elementTypeId,
  index,
  value,
  ctx,
  fnCtx,
}: {
  array: binaryen.ExpressionRef;
  arrayTypeId: TypeId;
  elementTypeId: TypeId;
  index: binaryen.ExpressionRef;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const wasmTypes = getFixedArrayWasmTypes(arrayTypeId, ctx);
  if (wasmTypes.kind === "inline-aggregate") {
    const laneTypes = wasmTypes.laneTypes ?? [];
    const laneArrayTypes = wasmTypes.laneArrayTypes ?? [];
    const captured = captureMultivalueLanes({
      value,
      abiTypes: laneTypes,
      ctx,
      fnCtx,
    });
    return ctx.mod.block(null, [
      ...captured.setup,
      ...captured.lanes.map((lane, laneIndex) =>
        arraySet(
          ctx.mod,
          structGetFieldValue({
            mod: ctx.mod,
            fieldIndex: laneIndex + 1,
            fieldType: laneArrayTypes[laneIndex]!,
            exprRef: array,
          }),
          index,
          lane,
        ),
      ),
    ]);
  }
  const elementType = wasmHeapFieldTypeFor(elementTypeId, ctx, new Set(), "runtime");
  return arraySet(
    ctx.mod,
    array,
    index,
    lowerValueForHeapField({
      value,
      typeId: elementTypeId,
      targetType: elementType,
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

const defaultValueForWasmType = (
  wasmType: binaryen.Type,
  ctx: CodegenContext,
): binaryen.ExpressionRef => {
  if (wasmType === binaryen.i32) return ctx.mod.i32.const(0);
  if (wasmType === binaryen.i64) return ctx.mod.i64.const(0, 0);
  if (wasmType === binaryen.f32) return ctx.mod.f32.const(0);
  if (wasmType === binaryen.f64) return ctx.mod.f64.const(0);
  return ctx.mod.ref.null(wasmType);
};

let labelCounter = 0;

const freshLabel = (prefix: string): string => `${prefix}_${labelCounter++}`;
