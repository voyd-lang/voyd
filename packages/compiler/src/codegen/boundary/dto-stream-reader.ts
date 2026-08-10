import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
  LocalBindingLocal,
  StructuralFieldInfo,
  TypeId,
} from "../context.js";
import {
  allocateTempLocal,
  loadLocalValue,
  storeLocalValue,
} from "../locals.js";
import {
  coerceValueToType,
  initStructuralValue,
  loadStructuralField,
} from "../structural.js";
import { lowerValueToMutableRefStorage, wasmTypeFor } from "../types.js";
import { emitStringLiteral } from "../expressions/primitives.js";
import { pickTraitImplMethodMeta } from "../function-lookup.js";
import { resolveImportedFunctionSymbol } from "../trait-dispatch-abi.js";
import {
  compileOptionalNoneValue,
  compileOptionalSomeValue,
} from "../optionals.js";
import type {
  BoundaryFieldSchema,
  BoundaryRecordSchema,
  BoundarySchema,
  BoundaryUnionSchema,
} from "./schema.js";
import { deriveBoundarySchema } from "./schema.js";
import {
  customDtoMethod,
  fixedArrayNew,
  fixedArraySet,
  lowerFieldValueForInit,
  requiredField,
  requiredStructuralInfo,
  unpackOptionalSomePayload,
  variantMatches,
} from "./dto-tree-codec.js";

type StreamReaderState = {
  readerTypeId: TypeId;
  resultTypeId: TypeId;
  rootTypeId: TypeId;
  methods: Map<string, FunctionMetadata>;
  errorLabel: string;
  rejectUnknownFields: binaryen.ExpressionRef;
  registry: Map<TypeId, BoundarySchema>;
  helpers: Map<TypeId, string>;
};

type ReaderCall = {
  expr: binaryen.ExpressionRef;
  meta: FunctionMetadata;
};

export const readDtoValueFromStream = ({
  reader,
  readerTypeId,
  rejectUnknownFields,
  schema,
  resultTypeId,
  ctx,
  fnCtx,
}: {
  reader: binaryen.ExpressionRef;
  readerTypeId: TypeId;
  rejectUnknownFields: binaryen.ExpressionRef;
  schema: BoundarySchema;
  resultTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const errorLabel = freshLabel("dto_stream_read_error");
  const state: StreamReaderState = {
    readerTypeId,
    resultTypeId,
    rootTypeId: schema.typeId,
    methods: resolveReaderMethods({ readerTypeId, ctx }),
    errorLabel,
    rejectUnknownFields,
    registry: new Map(),
    helpers: new Map(),
  };
  registerSchema({ schema, registry: state.registry });
  const readerLocal = allocateTempLocal(
    wasmTypeFor(readerTypeId, ctx),
    fnCtx,
    readerTypeId,
    ctx,
  );
  const readerRef = () => loadLocalValue(readerLocal, ctx);
  const value = readValue({ reader: readerRef, schema, state, ctx, fnCtx });
  return ctx.mod.block(
    errorLabel,
    [
      storeLocalValue({ binding: readerLocal, value: reader, ctx, fnCtx }),
      makeRootResult({
        member: "Ok",
        payload: value,
        payloadTypeId: schema.typeId,
        state,
        ctx,
        fnCtx,
      }),
    ],
    wasmTypeFor(resultTypeId, ctx),
  );
};

const readValue = ({
  reader,
  schema,
  state,
  ctx,
  fnCtx,
}: {
  reader: () => binaryen.ExpressionRef;
  schema: BoundarySchema;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (schema.kind === "ref") {
    const resolved = resolveSchemaRef({ schema, state, ctx });
    if (
      resolved.typeId !== state.rootTypeId &&
      !("aliases" in resolved && resolved.aliases?.includes(state.rootTypeId))
    ) {
      throw new Error(
        "direct DTO readers require a recursive reference to target the decoded root type",
      );
    }
    const helper = ensureRecursiveReadHelper({ schema, state, ctx });
    return unwrapResultExpression({
      expr: ctx.mod.call(
        helper,
        [reader(), state.rejectUnknownFields],
        wasmTypeFor(state.resultTypeId, ctx),
      ),
      resultTypeId: state.resultTypeId,
      resultWasmType: wasmTypeFor(state.resultTypeId, ctx),
      state,
      ctx,
      fnCtx,
    }).value;
  }
  switch (schema.kind) {
    case "custom":
      return readCustom({ reader, schema, state, ctx, fnCtx });
    case "bool":
      return readScalar({ name: "read_bool", reader, state, ctx, fnCtx }).value;
    case "i32":
      return readScalar({ name: "read_i32", reader, state, ctx, fnCtx }).value;
    case "i64":
      return readScalar({ name: "read_i64", reader, state, ctx, fnCtx }).value;
    case "f32":
      return readScalar({ name: "read_f32", reader, state, ctx, fnCtx }).value;
    case "f64":
      return readScalar({ name: "read_f64", reader, state, ctx, fnCtx }).value;
    case "string":
      return readScalar({ name: "read_string", reader, state, ctx, fnCtx })
        .value;
    case "bytes":
      return readScalar({ name: "read_bytes", reader, state, ctx, fnCtx })
        .value;
    case "void":
      return readScalar({ name: "read_null", reader, state, ctx, fnCtx }).value;
    case "array":
      return readArray({ reader, schema, state, ctx, fnCtx });
    case "record":
      return readRecord({ reader, schema, state, ctx, fnCtx });
    case "union":
      return readUnion({ reader, schema, state, ctx, fnCtx });
  }
};

const readScalar = ({
  name,
  reader,
  state,
  ctx,
  fnCtx,
}: {
  name: string;
  reader: () => binaryen.ExpressionRef;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): { value: binaryen.ExpressionRef; valueTypeId: TypeId } =>
  unwrapReaderResult({
    call: callReader({ name, reader, args: [], state, ctx, fnCtx }),
    state,
    ctx,
    fnCtx,
  });

const readArray = ({
  reader,
  schema,
  state,
  ctx,
  fnCtx,
}: {
  reader: () => binaryen.ExpressionRef;
  schema: Extract<BoundarySchema, { kind: "array" }>;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const info = requiredStructuralInfo(schema.typeId, ctx);
  const storageField = requiredField(info.fieldMap, "storage", schema.typeId);
  requiredField(info.fieldMap, "count", schema.typeId);
  const lengthRead = readScalar({
    name: "begin_array",
    reader,
    state,
    ctx,
    fnCtx,
  });
  const length = allocateTempLocal(binaryen.i32, fnCtx);
  const index = allocateTempLocal(binaryen.i32, fnCtx);
  const element = allocateTempLocal(
    wasmTypeFor(schema.elementTypeId, ctx),
    fnCtx,
    schema.elementTypeId,
    ctx,
  );
  const storage = allocateTempLocal(
    storageField.wasmType,
    fnCtx,
    storageField.typeId,
    ctx,
  );
  const lengthRef = () => loadLocalValue(length, ctx);
  const indexRef = () => loadLocalValue(index, ctx);
  const storageRef = () => loadLocalValue(storage, ctx);
  const loopLabel = freshLabel("dto_stream_read_array");
  const fieldValue = (field: StructuralFieldInfo): binaryen.ExpressionRef => {
    if (field.name === "storage") {
      return lowerFieldValueForInit({
        structInfo: info,
        field,
        value: storageRef(),
        ctx,
        fnCtx,
      });
    }
    if (field.name === "count") {
      return lowerFieldValueForInit({
        structInfo: info,
        field,
        value: lengthRef(),
        ctx,
        fnCtx,
      });
    }
    throw new Error(`unexpected Array DTO field ${field.name}`);
  };
  return ctx.mod.block(
    null,
    [
      storeLocalValue({ binding: length, value: lengthRead.value, ctx, fnCtx }),
      storeLocalValue({
        binding: storage,
        value: fixedArrayNew({
          arrayTypeId: storageField.typeId,
          elementTypeId: schema.elementTypeId,
          length: lengthRef(),
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
          ctx.mod.i32.lt_s(indexRef(), lengthRef()),
          ctx.mod.block(null, [
            fixedArraySet({
              array: storageRef(),
              elementTypeId: schema.elementTypeId,
              index: indexRef(),
              value: ctx.mod.block(
                null,
                [
                  callReaderRaw({
                    name: "enter_index",
                    reader,
                    args: [indexRef()],
                    state,
                    ctx,
                    fnCtx,
                  }),
                  storeLocalValue({
                    binding: element,
                    value: readValue({
                      reader,
                      schema: schema.element,
                      state,
                      ctx,
                      fnCtx,
                    }),
                    ctx,
                    fnCtx,
                  }),
                  callReaderRaw({
                    name: "leave",
                    reader,
                    args: [],
                    state,
                    ctx,
                    fnCtx,
                  }),
                  loadLocalValue(element, ctx),
                ],
                wasmTypeFor(schema.elementTypeId, ctx),
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
      checkedUnitCall({
        call: callReader({
          name: "end_array",
          reader,
          args: [],
          state,
          ctx,
          fnCtx,
        }),
        state,
        ctx,
        fnCtx,
      }),
      initStructuralValue({
        structInfo: info,
        fieldValues: info.fields.map(fieldValue),
        ctx,
        fnCtx,
      }),
    ],
    wasmTypeFor(schema.typeId, ctx),
  );
};

const readRecord = ({
  reader,
  schema,
  state,
  ctx,
  fnCtx,
}: {
  reader: () => binaryen.ExpressionRef;
  schema: BoundaryRecordSchema;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef =>
  ctx.mod.block(
    null,
    [
      checkedUnitCall({
        call: callReader({
          name: "begin_record",
          reader,
          args: [],
          state,
          ctx,
          fnCtx,
        }),
        state,
        ctx,
        fnCtx,
      }),
      readRecordFields({
        reader,
        typeId: schema.typeId,
        fields: schema.fields,
        endMethod: "end_record",
        state,
        ctx,
        fnCtx,
      }),
    ],
    wasmTypeFor(schema.typeId, ctx),
  );

const readUnion = ({
  reader,
  schema,
  state,
  ctx,
  fnCtx,
}: {
  reader: () => binaryen.ExpressionRef;
  schema: BoundaryUnionSchema;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const variantNameRead = readScalar({
    name: "begin_variant",
    reader,
    state,
    ctx,
    fnCtx,
  });
  const variantName = allocateTempLocal(
    wasmTypeFor(variantNameRead.valueTypeId, ctx),
    fnCtx,
    variantNameRead.valueTypeId,
    ctx,
  );
  const variantNameRef = () => loadLocalValue(variantName, ctx);
  const branches = schema.variants.reduceRight<binaryen.ExpressionRef>(
    (fallback, variant) =>
      ctx.mod.if(
        namesMatch({
          reader,
          actual: variantNameRef(),
          expected: variant.name,
          state,
          ctx,
          fnCtx,
        }),
        coerceValueToType({
          value: readRecordFields({
            reader,
            typeId: variant.typeId,
            fields: variant.fields,
            endMethod: "end_variant",
            state,
            ctx,
            fnCtx,
          }),
          actualType: variant.typeId,
          targetType: schema.typeId,
          ctx,
          fnCtx,
        }),
        fallback,
      ),
    rejectValue({
      reader,
      message: `unknown variant for ${schema.name}`,
      targetTypeId: schema.typeId,
      state,
      ctx,
      fnCtx,
    }),
  );
  return ctx.mod.block(
    null,
    [
      callReaderRaw({
        name: "enter_field",
        reader,
        args: [emitStringLiteral("$variant", ctx)],
        state,
        ctx,
        fnCtx,
      }),
      storeLocalValue({
        binding: variantName,
        value: variantNameRead.value,
        ctx,
        fnCtx,
      }),
      callReaderRaw({ name: "leave", reader, args: [], state, ctx, fnCtx }),
      branches,
    ],
    wasmTypeFor(schema.typeId, ctx),
  );
};

const readRecordFields = ({
  reader,
  typeId,
  fields,
  endMethod,
  state,
  ctx,
  fnCtx,
}: {
  reader: () => binaryen.ExpressionRef;
  typeId: TypeId;
  fields: readonly BoundaryFieldSchema[];
  endMethod: "end_record" | "end_variant";
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const info = requiredStructuralInfo(typeId, ctx);
  const values = new Map<string, LocalBindingLocal>();
  const seen = new Map<string, LocalBindingLocal>();
  fields.forEach((field) => {
    const structuralField = requiredField(info.fieldMap, field.name, typeId);
    const valueTypeId = field.optional ? field.typeId : structuralField.typeId;
    values.set(
      field.name,
      allocateTempLocal(wasmTypeFor(valueTypeId, ctx), fnCtx, valueTypeId, ctx),
    );
    seen.set(field.name, allocateTempLocal(binaryen.i32, fnCtx));
  });
  const nextRead = callReader({
    name: "next_field",
    reader,
    args: [],
    state,
    ctx,
    fnCtx,
  });
  const nextResult = unwrapReaderResult({ call: nextRead, state, ctx, fnCtx });
  const next = allocateTempLocal(
    wasmTypeFor(nextResult.valueTypeId, ctx),
    fnCtx,
    nextResult.valueTypeId,
    ctx,
  );
  const nextRef = () => loadLocalValue(next, ctx);
  const matched = allocateTempLocal(binaryen.i32, fnCtx);
  const loopLabel = freshLabel("dto_stream_read_fields");
  const [hasField, fieldName] = unpackOptionalSomePayload({
    value: nextRef,
    optionalTypeId: nextResult.valueTypeId,
    ctx,
    fnCtx,
  });
  const readKnownFields: binaryen.ExpressionRef[] = fields.map((field) => {
    const value = values.get(field.name)!;
    const wasSeen = seen.get(field.name)!;
    return ctx.mod.if(
      ctx.mod.i32.and(
        ctx.mod.i32.eq(loadLocalValue(matched, ctx), ctx.mod.i32.const(0)),
        namesMatch({
          reader,
          actual: fieldName,
          expected: field.name,
          state,
          ctx,
          fnCtx,
        }),
      ),
      ctx.mod.block(null, [
        ctx.mod.if(
          loadLocalValue(wasSeen, ctx),
          checkedUnitCall({
            call: callReader({
              name: "reject",
              reader,
              args: [emitStringLiteral(`duplicate field ${field.name}`, ctx)],
              state,
              ctx,
              fnCtx,
            }),
            state,
            ctx,
            fnCtx,
          }),
        ),
        callReaderRaw({
          name: "enter_field",
          reader,
          args: [emitStringLiteral(field.name, ctx)],
          state,
          ctx,
          fnCtx,
        }),
        storeLocalValue({
          binding: value,
          value: readValue({ reader, schema: field.schema, state, ctx, fnCtx }),
          ctx,
          fnCtx,
        }),
        callReaderRaw({ name: "leave", reader, args: [], state, ctx, fnCtx }),
        storeLocalValue({
          binding: wasSeen,
          value: ctx.mod.i32.const(1),
          ctx,
          fnCtx,
        }),
        storeLocalValue({
          binding: matched,
          value: ctx.mod.i32.const(1),
          ctx,
          fnCtx,
        }),
      ]),
    );
  });
  const unknownField = ctx.mod.if(
    ctx.mod.i32.eq(loadLocalValue(matched, ctx), ctx.mod.i32.const(0)),
    ctx.mod.block(null, [
      callReaderRaw({
        name: "enter_field",
        reader,
        args: [fieldName],
        state,
        ctx,
        fnCtx,
      }),
      ctx.mod.if(
        state.rejectUnknownFields,
        checkedUnitCall({
          call: callReader({
            name: "reject",
            reader,
            args: [emitStringLiteral("unknown field", ctx)],
            state,
            ctx,
            fnCtx,
          }),
          state,
          ctx,
          fnCtx,
        }),
        checkedUnitCall({
          call: callReader({
            name: "skip_value",
            reader,
            args: [],
            state,
            ctx,
            fnCtx,
          }),
          state,
          ctx,
          fnCtx,
        }),
      ),
      callReaderRaw({ name: "leave", reader, args: [], state, ctx, fnCtx }),
    ]),
  );
  const setup: binaryen.ExpressionRef[] = fields.map((field) =>
    storeLocalValue({
      binding: seen.get(field.name)!,
      value: ctx.mod.i32.const(0),
      ctx,
      fnCtx,
    }),
  );
  setup.push(
    ctx.mod.loop(
      loopLabel,
      ctx.mod.block(null, [
        storeLocalValue({ binding: next, value: nextResult.value, ctx, fnCtx }),
        ctx.mod.if(
          hasField,
          ctx.mod.block(null, [
            storeLocalValue({
              binding: matched,
              value: ctx.mod.i32.const(0),
              ctx,
              fnCtx,
            }),
            ...readKnownFields,
            unknownField,
            ctx.mod.br(loopLabel),
          ]),
        ),
      ]),
    ),
    checkedUnitCall({
      call: callReader({
        name: endMethod,
        reader,
        args: [],
        state,
        ctx,
        fnCtx,
      }),
      state,
      ctx,
      fnCtx,
    }),
  );
  fields.forEach((field) => {
    if (field.optional) return;
    setup.push(
      ctx.mod.if(
        ctx.mod.i32.eq(
          loadLocalValue(seen.get(field.name)!, ctx),
          ctx.mod.i32.const(0),
        ),
        ctx.mod.block(null, [
          callReaderRaw({
            name: "enter_field",
            reader,
            args: [emitStringLiteral(field.name, ctx)],
            state,
            ctx,
            fnCtx,
          }),
          checkedUnitCall({
            call: callReader({
              name: "reject",
              reader,
              args: [
                emitStringLiteral(`missing required field ${field.name}`, ctx),
              ],
              state,
              ctx,
              fnCtx,
            }),
            state,
            ctx,
            fnCtx,
          }),
          callReaderRaw({ name: "leave", reader, args: [], state, ctx, fnCtx }),
        ]),
      ),
    );
  });
  const fieldValues = info.fields.map((structuralField) => {
    const field = fields.find(
      (candidate) => candidate.name === structuralField.name,
    );
    if (!field)
      throw new Error(`DTO plan missing field ${structuralField.name}`);
    const value = loadLocalValue(values.get(field.name)!, ctx);
    const decoded = field.optional
      ? ctx.mod.if(
          loadLocalValue(seen.get(field.name)!, ctx),
          compileOptionalSomeValue({
            targetTypeId: structuralField.typeId,
            value,
            valueTypeId: field.typeId,
            ctx,
            fnCtx,
          }),
          compileOptionalNoneValue({
            targetTypeId: structuralField.typeId,
            ctx,
            fnCtx,
          }),
        )
      : value;
    return lowerFieldValueForInit({
      structInfo: info,
      field: structuralField,
      value: decoded,
      ctx,
      fnCtx,
    });
  });
  setup.push(
    initStructuralValue({ structInfo: info, fieldValues, ctx, fnCtx }),
  );
  return ctx.mod.block(null, setup, wasmTypeFor(typeId, ctx));
};

const readCustom = ({
  reader,
  schema,
  state,
  ctx,
  fnCtx,
}: {
  reader: () => binaryen.ExpressionRef;
  schema: Extract<BoundarySchema, { kind: "custom" }>;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const representation = readValue({
    reader,
    schema: schema.representation,
    state,
    ctx,
    fnCtx,
  });
  const method = customDtoMethod({ schema, name: "read", ctx });
  const result = ctx.mod.call(
    method.wasmName,
    [
      coerceValueToType({
        value: representation,
        actualType: schema.representationTypeId,
        targetType: method.paramTypeIds[0]!,
        ctx,
        fnCtx,
      }),
    ],
    method.resultType,
  );
  const resultLocal = allocateTempLocal(
    method.resultType,
    fnCtx,
    method.resultTypeId,
    ctx,
  );
  const resultRef = () => loadLocalValue(resultLocal, ctx);
  const ok = resultMember({
    resultTypeId: method.resultTypeId,
    name: "Ok",
    ctx,
  });
  const error = resultMember({
    resultTypeId: method.resultTypeId,
    name: "Err",
    ctx,
  });
  const errorInfo = requiredStructuralInfo(error, ctx);
  const errorField = requiredField(errorInfo.fieldMap, "error", error);
  const customErrorTypeId = errorField.typeId;
  const customErrorInfo = requiredStructuralInfo(customErrorTypeId, ctx);
  const messageField = requiredField(
    customErrorInfo.fieldMap,
    "message",
    customErrorTypeId,
  );
  const customErrorValue = resultPayload({
    value: resultRef(),
    resultTypeId: method.resultTypeId,
    memberTypeId: error,
    fieldName: "error",
    ctx,
    fnCtx,
  });
  const message = loadStructuralField({
    structInfo: customErrorInfo,
    field: messageField,
    pointer: () => customErrorValue,
    ctx,
    fnCtx,
  });
  return ctx.mod.block(
    null,
    [
      storeLocalValue({ binding: resultLocal, value: result, ctx, fnCtx }),
      ctx.mod.if(
        variantMatches({
          unionValue: resultRef(),
          unionTypeId: method.resultTypeId,
          variant: { name: "Err", typeId: error, fields: [] },
          ctx,
        }),
        checkedUnitCall({
          call: callReader({
            name: "reject",
            reader,
            args: [message],
            state,
            ctx,
            fnCtx,
          }),
          state,
          ctx,
          fnCtx,
        }),
      ),
      resultPayload({
        value: resultRef(),
        resultTypeId: method.resultTypeId,
        memberTypeId: ok,
        fieldName: "value",
        ctx,
        fnCtx,
      }),
    ],
    wasmTypeFor(schema.typeId, ctx),
  );
};

const rejectValue = ({
  reader,
  message,
  targetTypeId,
  state,
  ctx,
  fnCtx,
}: {
  reader: () => binaryen.ExpressionRef;
  message: string;
  targetTypeId: TypeId;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef =>
  ctx.mod.block(
    null,
    [
      checkedUnitCall({
        call: callReader({
          name: "reject",
          reader,
          args: [emitStringLiteral(message, ctx)],
          state,
          ctx,
          fnCtx,
        }),
        state,
        ctx,
        fnCtx,
      }),
      ctx.mod.unreachable(),
    ],
    wasmTypeFor(targetTypeId, ctx),
  );

const namesMatch = ({
  reader,
  actual,
  expected,
  state,
  ctx,
  fnCtx,
}: {
  reader: () => binaryen.ExpressionRef;
  actual: binaryen.ExpressionRef;
  expected: string;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef =>
  callReader({
    name: "matches_name",
    reader,
    args: [actual, emitStringLiteral(expected, ctx)],
    state,
    ctx,
    fnCtx,
  }).expr;

const checkedUnitCall = ({
  call,
  state,
  ctx,
  fnCtx,
}: {
  call: ReaderCall;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const value = unwrapReaderResult({ call, state, ctx, fnCtx }).value;
  const type = binaryen.getExpressionType(value);
  return type === binaryen.none || type === binaryen.unreachable
    ? value
    : ctx.mod.drop(value);
};

const unwrapReaderResult = ({
  call,
  state,
  ctx,
  fnCtx,
}: {
  call: ReaderCall;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): { value: binaryen.ExpressionRef; valueTypeId: TypeId } =>
  unwrapResultExpression({
    expr: call.expr,
    resultTypeId: call.meta.resultTypeId,
    resultWasmType: call.meta.resultType,
    state,
    ctx,
    fnCtx,
  });

const unwrapResultExpression = ({
  expr,
  resultTypeId,
  resultWasmType,
  state,
  ctx,
  fnCtx,
}: {
  expr: binaryen.ExpressionRef;
  resultTypeId: TypeId;
  resultWasmType: binaryen.Type;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): { value: binaryen.ExpressionRef; valueTypeId: TypeId } => {
  const result = allocateTempLocal(resultWasmType, fnCtx, resultTypeId, ctx);
  const resultRef = () => loadLocalValue(result, ctx);
  const ok = resultMember({ resultTypeId, name: "Ok", ctx });
  const err = resultMember({ resultTypeId, name: "Err", ctx });
  const okInfo = requiredStructuralInfo(ok, ctx);
  const valueField = requiredField(okInfo.fieldMap, "value", ok);
  const errorValue = resultPayload({
    value: resultRef(),
    resultTypeId,
    memberTypeId: err,
    fieldName: "error",
    ctx,
    fnCtx,
  });
  const value = resultPayload({
    value: resultRef(),
    resultTypeId,
    memberTypeId: ok,
    fieldName: "value",
    ctx,
    fnCtx,
  });
  return {
    value: ctx.mod.block(
      null,
      [
        storeLocalValue({ binding: result, value: expr, ctx, fnCtx }),
        ctx.mod.if(
          variantMatches({
            unionValue: resultRef(),
            unionTypeId: resultTypeId,
            variant: { name: "Err", typeId: err, fields: [] },
            ctx,
          }),
          ctx.mod.br(
            state.errorLabel,
            undefined,
            makeRootResult({
              member: "Err",
              payload: errorValue,
              payloadTypeId: requiredField(
                requiredStructuralInfo(err, ctx).fieldMap,
                "error",
                err,
              ).typeId,
              state,
              ctx,
              fnCtx,
            }),
          ),
        ),
        value,
      ],
      wasmTypeFor(valueField.typeId, ctx),
    ),
    valueTypeId: valueField.typeId,
  };
};

const ensureRecursiveReadHelper = ({
  schema,
  state,
  ctx,
}: {
  schema: Extract<BoundarySchema, { kind: "ref" }>;
  state: StreamReaderState;
  ctx: CodegenContext;
}): string => {
  const existing = state.helpers.get(schema.typeId);
  if (existing) return existing;
  const name = freshLabel(`__voyd_dto_stream_read_${schema.typeId}`);
  state.helpers.set(schema.typeId, name);
  const readerType = wasmTypeFor(state.readerTypeId, ctx);
  const params = binaryen.createType([readerType, binaryen.i32]);
  const locals: binaryen.Type[] = [];
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals,
    nextLocalIndex: binaryen.expandType(params).length,
    returnTypeId: state.resultTypeId,
    effectful: false,
  };
  const errorLabel = freshLabel("dto_stream_recursive_read_error");
  const helperState: StreamReaderState = {
    ...state,
    errorLabel,
    rejectUnknownFields: ctx.mod.local.get(1, binaryen.i32),
  };
  const resolved = resolveSchemaRef({ schema, state, ctx });
  const value = readValue({
    reader: () => ctx.mod.local.get(0, readerType),
    schema: resolved,
    state: helperState,
    ctx,
    fnCtx,
  });
  ctx.mod.addFunction(
    name,
    params,
    wasmTypeFor(state.resultTypeId, ctx),
    locals,
    ctx.mod.block(
      errorLabel,
      [
        makeRootResult({
          member: "Ok",
          payload: value,
          payloadTypeId: resolved.typeId,
          state: helperState,
          ctx,
          fnCtx,
        }),
      ],
      wasmTypeFor(state.resultTypeId, ctx),
    ),
  );
  return name;
};

const registerSchema = ({
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
    case "custom":
      registerSchema({ schema: schema.representation, registry });
      return;
    case "array":
      registerSchema({ schema: schema.element, registry });
      return;
    case "record":
      schema.fields.forEach((field) =>
        registerSchema({ schema: field.schema, registry }),
      );
      return;
    case "union":
      schema.variants.forEach((variant) =>
        variant.fields.forEach((field) =>
          registerSchema({ schema: field.schema, registry }),
        ),
      );
      return;
    default:
      return;
  }
};

const resolveSchemaRef = ({
  schema,
  state,
  ctx,
}: {
  schema: Extract<BoundarySchema, { kind: "ref" }>;
  state: StreamReaderState;
  ctx: CodegenContext;
}): BoundarySchema => {
  const resolved =
    state.registry.get(schema.typeId) ??
    deriveBoundarySchema({ typeId: schema.typeId, ctx });
  if (resolved.kind === "ref") {
    throw new Error(`unresolved recursive DTO reference ${schema.typeId}`);
  }
  registerSchema({ schema: resolved, registry: state.registry });
  return resolved;
};

const makeRootResult = ({
  member,
  payload,
  payloadTypeId,
  state,
  ctx,
  fnCtx,
}: {
  member: "Ok" | "Err";
  payload: binaryen.ExpressionRef;
  payloadTypeId: TypeId;
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const memberTypeId = resultMember({
    resultTypeId: state.resultTypeId,
    name: member,
    ctx,
  });
  const info = requiredStructuralInfo(memberTypeId, ctx);
  const fieldName = member === "Ok" ? "value" : "error";
  const field = requiredField(info.fieldMap, fieldName, memberTypeId);
  return coerceValueToType({
    value: initStructuralValue({
      structInfo: info,
      fieldValues: [
        lowerFieldValueForInit({
          structInfo: info,
          field,
          value: coerceValueToType({
            value: payload,
            actualType: payloadTypeId,
            targetType: field.typeId,
            ctx,
            fnCtx,
          }),
          ctx,
          fnCtx,
        }),
      ],
      ctx,
      fnCtx,
    }),
    actualType: memberTypeId,
    targetType: state.resultTypeId,
    ctx,
    fnCtx,
  });
};

const resultPayload = ({
  value,
  resultTypeId,
  memberTypeId,
  fieldName,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  resultTypeId: TypeId;
  memberTypeId: TypeId;
  fieldName: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const info = requiredStructuralInfo(memberTypeId, ctx);
  const field = requiredField(info.fieldMap, fieldName, memberTypeId);
  const member = coerceValueToType({
    value,
    actualType: resultTypeId,
    targetType: memberTypeId,
    ctx,
    fnCtx,
  });
  return loadStructuralField({
    structInfo: info,
    field,
    pointer: () => member,
    ctx,
    fnCtx,
  });
};

const resultMember = ({
  resultTypeId,
  name,
  ctx,
}: {
  resultTypeId: TypeId;
  name: "Ok" | "Err";
  ctx: CodegenContext;
}): TypeId => {
  const desc = ctx.program.types.getTypeDesc(resultTypeId);
  if (desc.kind !== "union")
    throw new Error("DataReader method must return Result");
  const member = desc.members.find((typeId) => {
    const memberDesc = ctx.program.types.getTypeDesc(typeId);
    const owner = ctx.program.types.getNominalOwner(
      memberDesc.kind === "intersection" && memberDesc.nominal !== undefined
        ? memberDesc.nominal
        : typeId,
    );
    return owner !== undefined && ctx.program.symbols.getName(owner) === name;
  });
  if (member === undefined) throw new Error(`Result is missing ${name}`);
  return member;
};

const callReader = ({
  name,
  reader,
  args,
  state,
  ctx,
  fnCtx,
}: {
  name: string;
  reader: () => binaryen.ExpressionRef;
  args: readonly binaryen.ExpressionRef[];
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): ReaderCall => {
  const method = state.methods.get(name);
  if (!method) throw new Error(`DataReader implementation is missing ${name}`);
  const receiver =
    method.paramAbiKinds[0] === "mutable_ref"
      ? lowerValueToMutableRefStorage({
          value: reader(),
          typeId: method.paramTypeIds[0]!,
          targetType: method.paramTypes[method.firstUserParamIndex]!,
          ctx,
        })
      : coerceValueToType({
          value: reader(),
          actualType: state.readerTypeId,
          targetType: method.paramTypeIds[0]!,
          ctx,
          fnCtx,
        });
  return {
    expr: ctx.mod.call(method.wasmName, [receiver, ...args], method.resultType),
    meta: method,
  };
};

const callReaderRaw = ({
  name,
  reader,
  args,
  state,
  ctx,
  fnCtx,
}: {
  name: string;
  reader: () => binaryen.ExpressionRef;
  args: readonly binaryen.ExpressionRef[];
  state: StreamReaderState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef =>
  callReader({ name, reader, args, state, ctx, fnCtx }).expr;

const resolveReaderMethods = ({
  readerTypeId,
  ctx,
}: {
  readerTypeId: TypeId;
  ctx: CodegenContext;
}): Map<string, FunctionMetadata> => {
  const desc = ctx.program.types.getTypeDesc(readerTypeId);
  const nominal =
    desc.kind === "intersection" && desc.nominal !== undefined
      ? desc.nominal
      : (ctx.program.types.getNominalOwner(readerTypeId) ?? readerTypeId);
  const impl = ctx.program.traits
    .getImplsByNominal(nominal)
    .find(
      (candidate) =>
        ctx.program.symbols.getName(candidate.traitSymbol) === "DataReader",
    );
  if (!impl)
    throw new Error(
      "DTO stream reader requires a concrete DataReader implementation",
    );
  return new Map(
    impl.methods.map(({ traitMethod, implMethod }) => {
      const name = ctx.program.symbols.getName(traitMethod);
      if (!name) throw new Error("DataReader method is missing a symbol name");
      const ref = ctx.program.symbols.refOf(implMethod);
      const resolved = resolveImportedFunctionSymbol({ ctx, ...ref });
      const meta = pickTraitImplMethodMeta({
        metas: ctx.functions.get(resolved.moduleId)?.get(resolved.symbol),
        impl,
        runtimeType: ctx.rtt.baseType,
        ctx,
      });
      if (!meta)
        throw new Error(`missing codegen metadata for DataReader.${name}`);
      return [name, meta] as const;
    }),
  );
};

let nextLabel = 0;
const freshLabel = (prefix: string): string => `${prefix}_${nextLabel++}`;
