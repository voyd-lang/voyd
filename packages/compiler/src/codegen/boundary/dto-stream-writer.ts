import binaryen from "binaryen";
import {
  arrayGet,
  arrayNew,
  arraySet,
  binaryenTypeToHeapType,
  defineArrayType,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
  LocalBindingLocal,
  TypeId,
} from "../context.js";
import {
  allocateTempLocal,
  loadLocalValue,
  storeLocalValue,
} from "../locals.js";
import { coerceValueToType, loadStructuralField } from "../structural.js";
import { lowerValueToMutableRefStorage, wasmTypeFor } from "../types.js";
import { emitStringLiteral } from "../expressions/primitives.js";
import { pickTraitImplMethodMeta } from "../function-lookup.js";
import { resolveImportedFunctionSymbol } from "../trait-dispatch-abi.js";
import { RTT_METADATA_SLOTS } from "../rtt/index.js";
import { coerceExprToWasmType } from "../wasm-type-coercions.js";
import type {
  BoundaryFieldSchema,
  BoundaryRecordSchema,
  BoundarySchema,
  BoundaryUnionSchema,
  BoundaryVariantSchema,
} from "./schema.js";
import { deriveBoundarySchema } from "./schema.js";
import {
  callCustomDtoWrite,
  fixedArrayGet,
  requiredField,
  requiredStructuralInfo,
  unpackOptionalSomePayload,
  variantMatches,
} from "./dto-tree-codec.js";

const DTO_STREAM_CYCLE_ERROR =
  "__voyd_dto_error: cannot encode cyclic object graph or DTO object graph exceeds maximum depth";

type StreamWriterState = {
  writerTypeId: TypeId;
  resultTypeId: TypeId;
  methods: Map<string, FunctionMetadata>;
  registry: Map<TypeId, BoundarySchema>;
  helpers: Map<TypeId, string>;
  activeHelpers: Set<TypeId>;
  errorLabel: string;
  ancestorStackType?: binaryen.Type;
};

export const writeDtoValueToStream = ({
  writer,
  writerTypeId,
  value,
  schema,
  resultTypeId,
  ctx,
  fnCtx,
}: {
  writer: binaryen.ExpressionRef;
  writerTypeId: TypeId;
  value: binaryen.ExpressionRef;
  schema: BoundarySchema;
  resultTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const writerLocal = allocateTempLocal(
    wasmTypeFor(writerTypeId, ctx),
    fnCtx,
    writerTypeId,
    ctx,
  );
  return ctx.mod.block(
    null,
    [
      storeLocalValue({ binding: writerLocal, value: writer, ctx, fnCtx }),
      writeDtoValueToHostStream({
        writer: () => loadLocalValue(writerLocal, ctx),
        writerTypeId,
        value,
        schema,
        resultTypeId,
        ctx,
        fnCtx,
      }),
    ],
    wasmTypeFor(resultTypeId, ctx),
  );
};

/** Writes a DTO through an already-stable host writer reference. */
export const writeDtoValueToHostStream = ({
  writer,
  writerTypeId,
  value,
  schema,
  resultTypeId,
  ctx,
  fnCtx,
}: {
  writer: () => binaryen.ExpressionRef;
  writerTypeId: TypeId;
  value: binaryen.ExpressionRef;
  schema: BoundarySchema;
  resultTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const errorLabel = freshLabel("dto_stream_write_error");
  const state: StreamWriterState = {
    writerTypeId,
    resultTypeId,
    methods: resolveWriterMethods({ writerTypeId, ctx }),
    registry: new Map(),
    helpers: new Map(),
    activeHelpers: new Set(),
    errorLabel,
  };
  registerSchema({ schema, registry: state.registry });
  const ancestorStack = emptyAncestorStack({ state, ctx });
  return ctx.mod.block(
    errorLabel,
    [
      writeValue({
        writer,
        value,
        schema,
        ancestors: ancestorStack,
        ancestorCount: ctx.mod.i32.const(0),
        state,
        ctx,
        fnCtx,
      }),
    ],
    wasmTypeFor(resultTypeId, ctx),
  );
};

/** Emits one provider-neutral framing event into a host stream writer. */
export const writeHostStreamEvent = ({
  writer,
  writerTypeId,
  name,
  args,
  ctx,
  fnCtx,
}: {
  writer: binaryen.ExpressionRef;
  writerTypeId: TypeId;
  name: string;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const methods = resolveWriterMethods({ writerTypeId, ctx });
  const method = methods.get(name);
  if (!method) throw new Error(`DataWriter implementation is missing ${name}`);
  const state: StreamWriterState = {
    writerTypeId,
    resultTypeId: method.resultTypeId,
    methods,
    registry: new Map(),
    helpers: new Map(),
    activeHelpers: new Set(),
    errorLabel: freshLabel("host_stream_writer_error"),
  };
  const loweredArgs = args.map((arg, index) => {
    const parameterIndex = index + 1;
    const typeId = method.paramTypeIds[parameterIndex];
    const targetType =
      method.paramAbiTypes[parameterIndex]?.[0] ??
      method.paramTypes.at(-args.length + index);
    if (
      typeof typeId !== "number" ||
      typeof targetType !== "number" ||
      targetType === binaryen.i32 ||
      targetType === binaryen.i64 ||
      targetType === binaryen.f32 ||
      targetType === binaryen.f64
    ) {
      return arg;
    }
    return lowerValueToMutableRefStorage({
      value: arg,
      typeId,
      targetType,
      ctx,
    });
  });
  const call = callWriter({
    name,
    writer: () => writer,
    args: loweredArgs,
    state,
    ctx,
    fnCtx,
  });
  const type = binaryen.getExpressionType(call);
  return type === binaryen.none || type === binaryen.unreachable
    ? call
    : ctx.mod.drop(call);
};

export const hostStreamWriterResultTypeId = ({
  writerTypeId,
  ctx,
}: {
  writerTypeId: TypeId;
  ctx: CodegenContext;
}): TypeId => {
  const method = resolveWriterMethods({ writerTypeId, ctx }).get("end_array");
  if (!method)
    throw new Error("DataWriter implementation is missing end_array");
  return method.resultTypeId;
};

const writeValue = ({
  writer,
  value,
  schema,
  ancestors,
  ancestorCount,
  state,
  ctx,
  fnCtx,
}: {
  writer: () => binaryen.ExpressionRef;
  value: binaryen.ExpressionRef;
  schema: BoundarySchema;
  ancestors: binaryen.ExpressionRef;
  ancestorCount: binaryen.ExpressionRef;
  state: StreamWriterState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (schema.kind === "ref") {
    const helper = ensureRecursiveWriteHelper({ schema, state, ctx });
    return ctx.mod.call(
      helper,
      [writer(), value, ancestors, ancestorCount],
      wasmTypeFor(state.resultTypeId, ctx),
    );
  }
  switch (schema.kind) {
    case "custom":
      return writeValue({
        writer,
        value: callCustomDtoWrite({ value, schema, ctx, fnCtx }),
        schema: schema.representation,
        ancestors,
        ancestorCount,
        state,
        ctx,
        fnCtx,
      });
    case "bool":
      return callWriter({
        name: "write_bool",
        writer,
        args: [value],
        state,
        ctx,
        fnCtx,
      });
    case "i32":
      return callWriter({
        name: "write_i32",
        writer,
        args: [value],
        state,
        ctx,
        fnCtx,
      });
    case "i64":
      return callWriter({
        name: "write_i64",
        writer,
        args: [value],
        state,
        ctx,
        fnCtx,
      });
    case "f32":
      return callWriter({
        name: "write_f32",
        writer,
        args: [value],
        state,
        ctx,
        fnCtx,
      });
    case "f64":
      return callWriter({
        name: "write_f64",
        writer,
        args: [value],
        state,
        ctx,
        fnCtx,
      });
    case "string":
      return callWriter({
        name: "write_string",
        writer,
        args: [value],
        state,
        ctx,
        fnCtx,
      });
    case "bytes":
      return callWriter({
        name: "write_bytes",
        writer,
        args: [value],
        state,
        ctx,
        fnCtx,
      });
    case "void": {
      const valueType = binaryen.getExpressionType(value);
      const valueOp =
        valueType === binaryen.none || valueType === binaryen.unreachable
          ? value
          : ctx.mod.drop(value);
      return ctx.mod.block(
        null,
        [
          valueOp,
          callWriter({
            name: "write_null",
            writer,
            args: [],
            state,
            ctx,
            fnCtx,
          }),
        ],
        wasmTypeFor(state.resultTypeId, ctx),
      );
    }
    case "array":
      return writeArray({
        writer,
        value,
        schema,
        ancestors,
        ancestorCount,
        state,
        ctx,
        fnCtx,
      });
    case "record":
      return writeRecord({
        writer,
        value,
        schema,
        ancestors,
        ancestorCount,
        state,
        ctx,
        fnCtx,
      });
    case "union":
      return writeUnion({
        writer,
        value,
        schema,
        ancestors,
        ancestorCount,
        state,
        ctx,
        fnCtx,
      });
  }
};

const writeArray = ({
  writer,
  value,
  schema,
  ancestors,
  ancestorCount,
  state,
  ctx,
  fnCtx,
}: Parameters<typeof writeValue>[0] & {
  schema: Extract<BoundarySchema, { kind: "array" }>;
}): binaryen.ExpressionRef => {
  const info = requiredStructuralInfo(schema.typeId, ctx);
  const storageField = requiredField(info.fieldMap, "storage", schema.typeId);
  const countField = requiredField(info.fieldMap, "count", schema.typeId);
  const source = allocateTempLocal(
    wasmTypeFor(schema.typeId, ctx),
    fnCtx,
    schema.typeId,
    ctx,
  );
  const count = allocateTempLocal(binaryen.i32, fnCtx);
  const index = allocateTempLocal(binaryen.i32, fnCtx);
  const sourceRef = () => loadLocalValue(source, ctx);
  const countRef = () => loadLocalValue(count, ctx);
  const indexRef = () => loadLocalValue(index, ctx);
  const storageRef = () =>
    loadStructuralField({
      structInfo: info,
      field: storageField,
      pointer: sourceRef,
      ctx,
      fnCtx,
    });
  const loopLabel = freshLabel("dto_stream_write_array");
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
          fnCtx,
        }),
        ctx,
        fnCtx,
      }),
      checkedWriterCall({
        call: callWriter({
          name: "begin_array",
          writer,
          args: [countRef()],
          state,
          ctx,
          fnCtx,
        }),
        state,
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
            checkedWriterCall({
              call: writeValue({
                writer,
                value: fixedArrayGet({
                  array: storageRef(),
                  elementTypeId: schema.elementTypeId,
                  index: indexRef(),
                  ctx,
                  fnCtx,
                }),
                schema: schema.element,
                ancestors,
                ancestorCount,
                state,
                ctx,
                fnCtx,
              }),
              state,
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
      callWriter({ name: "end_array", writer, args: [], state, ctx, fnCtx }),
    ],
    wasmTypeFor(state.resultTypeId, ctx),
  );
};

const writeRecord = ({
  writer,
  value,
  schema,
  ancestors,
  ancestorCount,
  state,
  ctx,
  fnCtx,
}: Parameters<typeof writeValue>[0] & {
  schema: BoundaryRecordSchema;
}): binaryen.ExpressionRef =>
  writeRecordFields({
    writer,
    value,
    typeId: schema.typeId,
    name: schema.name,
    fields: schema.fields,
    ancestors,
    ancestorCount,
    state,
    ctx,
    fnCtx,
  });

const writeUnion = ({
  writer,
  value,
  schema,
  ancestors,
  ancestorCount,
  state,
  ctx,
  fnCtx,
}: Parameters<typeof writeValue>[0] & {
  schema: BoundaryUnionSchema;
}): binaryen.ExpressionRef => {
  const source = allocateTempLocal(
    wasmTypeFor(schema.typeId, ctx),
    fnCtx,
    schema.typeId,
    ctx,
  );
  const sourceRef = () => loadLocalValue(source, ctx);
  const branches = schema.variants.reduceRight<binaryen.ExpressionRef>(
    (fallback, variant) =>
      ctx.mod.if(
        variantMatches({
          unionValue: sourceRef(),
          unionTypeId: schema.typeId,
          variant,
          ctx,
        }),
        writeRecordFields({
          writer,
          value: coerceValueToType({
            value: sourceRef(),
            actualType: schema.typeId,
            targetType: variant.typeId,
            ctx,
            fnCtx,
          }),
          typeId: variant.typeId,
          name: schema.name,
          variant,
          fields: variant.fields,
          ancestors,
          ancestorCount,
          state,
          ctx,
          fnCtx,
        }),
        fallback,
      ),
    ctx.mod.block(
      null,
      [ctx.mod.unreachable()],
      wasmTypeFor(state.resultTypeId, ctx),
    ),
  );
  return ctx.mod.block(
    null,
    [storeLocalValue({ binding: source, value, ctx, fnCtx }), branches],
    wasmTypeFor(state.resultTypeId, ctx),
  );
};

const writeRecordFields = ({
  writer,
  value,
  typeId,
  name,
  variant,
  fields,
  ancestors,
  ancestorCount,
  state,
  ctx,
  fnCtx,
}: {
  writer: () => binaryen.ExpressionRef;
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  name: string;
  variant?: BoundaryVariantSchema;
  fields: readonly BoundaryFieldSchema[];
  ancestors: binaryen.ExpressionRef;
  ancestorCount: binaryen.ExpressionRef;
  state: StreamWriterState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const info = requiredStructuralInfo(typeId, ctx);
  const source = allocateTempLocal(
    wasmTypeFor(typeId, ctx),
    fnCtx,
    typeId,
    ctx,
  );
  const fieldCount = allocateTempLocal(binaryen.i32, fnCtx);
  const sourceRef = () => loadLocalValue(source, ctx);
  const fieldCountRef = () => loadLocalValue(fieldCount, ctx);
  const optionalLocals = new Map<string, LocalBindingLocal>();
  const setup: binaryen.ExpressionRef[] = [
    storeLocalValue({ binding: source, value, ctx, fnCtx }),
    storeLocalValue({
      binding: fieldCount,
      value: ctx.mod.i32.const(
        fields.filter((field) => !field.optional).length,
      ),
      ctx,
      fnCtx,
    }),
  ];
  fields.forEach((field) => {
    if (!field.optional) return;
    const structuralField = requiredField(info.fieldMap, field.name, typeId);
    const local = allocateTempLocal(
      wasmTypeFor(structuralField.typeId, ctx),
      fnCtx,
      structuralField.typeId,
      ctx,
    );
    optionalLocals.set(field.name, local);
    setup.push(
      storeLocalValue({
        binding: local,
        value: loadStructuralField({
          structInfo: info,
          field: structuralField,
          pointer: sourceRef,
          ctx,
          fnCtx,
        }),
        ctx,
        fnCtx,
      }),
    );
    const [isSome] = unpackOptionalSomePayload({
      value: () => loadLocalValue(local, ctx),
      optionalTypeId: structuralField.typeId,
      ctx,
      fnCtx,
    });
    setup.push(
      ctx.mod.if(
        isSome,
        storeLocalValue({
          binding: fieldCount,
          value: ctx.mod.i32.add(fieldCountRef(), ctx.mod.i32.const(1)),
          ctx,
          fnCtx,
        }),
      ),
    );
  });
  setup.push(
    checkedWriterCall({
      call: variant
        ? callWriter({
            name: "begin_variant",
            writer,
            args: [
              emitStringLiteral(name, ctx),
              emitStringLiteral(variant.name, ctx),
              fieldCountRef(),
            ],
            state,
            ctx,
            fnCtx,
          })
        : callWriter({
            name: "begin_record",
            writer,
            args: [emitStringLiteral(name, ctx), fieldCountRef()],
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
    const structuralField = requiredField(info.fieldMap, field.name, typeId);
    const writeField = (
      fieldValue: binaryen.ExpressionRef,
    ): binaryen.ExpressionRef =>
      ctx.mod.block(null, [
        checkedWriterCall({
          call: callWriter({
            name: "write_field",
            writer,
            args: [emitStringLiteral(field.name, ctx)],
            state,
            ctx,
            fnCtx,
          }),
          state,
          ctx,
          fnCtx,
        }),
        checkedWriterCall({
          call: writeValue({
            writer,
            value: fieldValue,
            schema: field.schema,
            ancestors,
            ancestorCount,
            state,
            ctx,
            fnCtx,
          }),
          state,
          ctx,
          fnCtx,
        }),
      ]);
    if (!field.optional) {
      setup.push(
        writeField(
          loadStructuralField({
            structInfo: info,
            field: structuralField,
            pointer: sourceRef,
            ctx,
            fnCtx,
          }),
        ),
      );
      return;
    }
    const optional = optionalLocals.get(field.name)!;
    const [isSome, someValue] = unpackOptionalSomePayload({
      value: () => loadLocalValue(optional, ctx),
      optionalTypeId: structuralField.typeId,
      ctx,
      fnCtx,
    });
    setup.push(ctx.mod.if(isSome, writeField(someValue)));
  });
  setup.push(
    callWriter({
      name: variant ? "end_variant" : "end_record",
      writer,
      args: [],
      state,
      ctx,
      fnCtx,
    }),
  );
  return ctx.mod.block(null, setup, wasmTypeFor(state.resultTypeId, ctx));
};

const callWriter = ({
  name,
  writer,
  args,
  state,
  ctx,
  fnCtx,
}: {
  name: string;
  writer: () => binaryen.ExpressionRef;
  args: readonly binaryen.ExpressionRef[];
  state: StreamWriterState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const method = state.methods.get(name);
  if (!method) throw new Error(`DataWriter implementation is missing ${name}`);
  const receiver = lowerValueToMutableRefStorage({
    value: writer(),
    typeId: method.paramTypeIds[0]!,
    targetType:
      method.paramAbiTypes[0]?.[0] ??
      method.paramTypes[method.firstUserParamIndex]!,
    ctx,
  });
  const actual = [receiver, ...args];
  const coerced = actual.map((arg, index) => {
    const targetTypeId = method.paramTypeIds[index];
    if (typeof targetTypeId !== "number") return arg;
    const abiKind = method.paramAbiKinds[index];
    const targetWasmType =
      method.paramAbiTypes[index]?.[0] ??
      method.paramTypes[method.firstUserParamIndex + index]!;
    if (
      index > 0 &&
      (abiKind === "readonly_ref" ||
        abiKind === "mutable_ref" ||
        (targetWasmType !== binaryen.i32 &&
          targetWasmType !== binaryen.i64 &&
          targetWasmType !== binaryen.f32 &&
          targetWasmType !== binaryen.f64 &&
          targetWasmType !== binaryen.none &&
          targetWasmType !== binaryen.getExpressionType(arg)))
    ) {
      return lowerValueToMutableRefStorage({
        value: arg,
        typeId: targetTypeId,
        targetType: targetWasmType,
        ctx,
      });
    }
    const actualTypeId =
      index === 0 && method.paramAbiKinds[0] !== "mutable_ref"
        ? state.writerTypeId
        : undefined;
    return typeof actualTypeId === "number"
      ? coerceValueToType({
          value: arg,
          actualType: actualTypeId,
          targetType: targetTypeId,
          ctx,
          fnCtx,
        })
      : arg;
  });
  return ctx.mod.call(method.wasmName, coerced, method.resultType);
};

const checkedWriterCall = ({
  call,
  state,
  ctx,
  fnCtx,
}: {
  call: binaryen.ExpressionRef;
  state: StreamWriterState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const result = allocateTempLocal(
    wasmTypeFor(state.resultTypeId, ctx),
    fnCtx,
    state.resultTypeId,
    ctx,
  );
  const resultRef = () => loadLocalValue(result, ctx);
  return ctx.mod.block(null, [
    storeLocalValue({ binding: result, value: call, ctx, fnCtx }),
    ctx.mod.if(
      resultIsErr({
        value: resultRef(),
        resultTypeId: state.resultTypeId,
        ctx,
      }),
      ctx.mod.br(state.errorLabel, undefined, resultRef()),
    ),
  ]);
};

const resultIsErr = ({
  value,
  resultTypeId,
  ctx,
}: {
  value: binaryen.ExpressionRef;
  resultTypeId: TypeId;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const errTypeId = unionMemberNamed({
    unionTypeId: resultTypeId,
    name: "Err",
    ctx,
  });
  const valueType = binaryen.getExpressionType(value);
  if (!isReferenceType(valueType)) {
    return variantMatches({
      unionValue: value,
      unionTypeId: resultTypeId,
      variant: { name: "Err", typeId: errTypeId, fields: [] },
      ctx,
    });
  }
  const errInfo = requiredStructuralInfo(errTypeId, ctx);
  return ctx.mod.call(
    "__has_type",
    [
      ctx.mod.i32.const(errInfo.runtimeTypeId),
      structGetFieldValue({
        mod: ctx.mod,
        fieldType: ctx.rtt.extensionHelpers.i32Array,
        fieldIndex: RTT_METADATA_SLOTS.ANCESTORS,
        exprRef: coerceExprToWasmType({
          expr: value,
          targetType: ctx.rtt.baseType,
          ctx,
        }),
      }),
    ],
    binaryen.i32,
  );
};

const isReferenceType = (type: binaryen.Type): boolean =>
  binaryen.expandType(type).length === 1 &&
  type !== binaryen.none &&
  type !== binaryen.unreachable &&
  type !== binaryen.i32 &&
  type !== binaryen.i64 &&
  type !== binaryen.f32 &&
  type !== binaryen.f64;

const unionMemberNamed = ({
  unionTypeId,
  name,
  ctx,
}: {
  unionTypeId: TypeId;
  name: string;
  ctx: CodegenContext;
}): TypeId => {
  const initial = ctx.program.types.getTypeDesc(unionTypeId);
  const desc =
    initial.kind === "recursive"
      ? ctx.program.types.getTypeDesc(
          ctx.program.types.substitute(
            initial.body,
            new Map([[initial.binder, unionTypeId]]),
          ),
        )
      : initial;
  if (desc.kind !== "union")
    throw new Error("DataWriter method must return Result");
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

const resolveWriterMethods = ({
  writerTypeId,
  ctx,
}: {
  writerTypeId: TypeId;
  ctx: CodegenContext;
}): Map<string, FunctionMetadata> => {
  const writerDesc = ctx.program.types.getTypeDesc(writerTypeId);
  const nominal =
    writerDesc.kind === "intersection" && writerDesc.nominal !== undefined
      ? writerDesc.nominal
      : (ctx.program.types.getNominalOwner(writerTypeId) ?? writerTypeId);
  const impl = ctx.program.traits
    .getImplsByNominal(nominal)
    .find(
      (candidate) =>
        ctx.program.symbols.getName(candidate.traitSymbol) === "DataWriter",
    );
  if (!impl) {
    const desc = ctx.program.types.getTypeDesc(writerTypeId);
    const implNames = ctx.program.traits
      .getImplsByNominal(nominal)
      .map((candidate) => ctx.program.symbols.getName(candidate.traitSymbol));
    throw new Error(
      `DTO stream writer requires a concrete DataWriter implementation (type=${writerTypeId}, nominal=${nominal}, kind=${desc.kind}, impls=${implNames.join(",")})`,
    );
  }
  return new Map(
    impl.methods.map(({ traitMethod, implMethod }) => {
      const name = ctx.program.symbols.getName(traitMethod);
      if (!name) throw new Error("DataWriter method is missing a symbol name");
      const ref = ctx.program.symbols.refOf(implMethod);
      const resolved = resolveImportedFunctionSymbol({ ctx, ...ref });
      const meta = pickTraitImplMethodMeta({
        metas: ctx.functions.get(resolved.moduleId)?.get(resolved.symbol),
        impl,
        runtimeType: ctx.rtt.baseType,
        ctx,
      });
      if (!meta)
        throw new Error(`missing codegen metadata for DataWriter.${name}`);
      return [name, meta] as const;
    }),
  );
};

const ensureRecursiveWriteHelper = ({
  schema,
  state,
  ctx,
}: {
  schema: Extract<BoundarySchema, { kind: "ref" }>;
  state: StreamWriterState;
  ctx: CodegenContext;
}): string => {
  const existing = state.helpers.get(schema.typeId);
  if (existing) return existing;
  const name = freshLabel(`__voyd_dto_stream_write_${schema.typeId}`);
  state.helpers.set(schema.typeId, name);
  if (state.activeHelpers.has(schema.typeId)) return name;
  state.activeHelpers.add(schema.typeId);
  const stackType = ancestorStackType({ state, ctx });
  const writerType = wasmTypeFor(state.writerTypeId, ctx);
  const valueType = wasmTypeFor(schema.typeId, ctx);
  const params = binaryen.createType([
    writerType,
    valueType,
    stackType,
    binaryen.i32,
  ]);
  const locals: binaryen.Type[] = [];
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals,
    nextLocalIndex: binaryen.expandType(params).length,
    returnTypeId: state.resultTypeId,
    effectful: false,
  };
  const errorLabel = freshLabel("dto_stream_recursive_error");
  const helperState: StreamWriterState = { ...state, errorLabel };
  const nextAncestors = allocateTempLocal(stackType, fnCtx);
  const body = writeValue({
    writer: () => ctx.mod.local.get(0, writerType),
    value: ctx.mod.local.get(1, valueType),
    schema: resolveSchemaRef({ schema, state, ctx }),
    ancestors: loadLocalValue(nextAncestors, ctx),
    ancestorCount: ctx.mod.i32.add(
      ctx.mod.local.get(3, binaryen.i32),
      ctx.mod.i32.const(1),
    ),
    state: helperState,
    ctx,
    fnCtx,
  });
  const cycleError = callWriter({
    name: "reject",
    writer: () => ctx.mod.local.get(0, writerType),
    args: [emitStringLiteral(DTO_STREAM_CYCLE_ERROR, ctx)],
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
        ctx.mod.if(
          ancestorStackContains({
            value: ctx.mod.local.get(1, valueType),
            ancestors: ctx.mod.local.get(2, stackType),
            count: ctx.mod.local.get(3, binaryen.i32),
            ctx,
            fnCtx,
          }),
          cycleError,
          ctx.mod.block(
            null,
            [
              storeLocalValue({
                binding: nextAncestors,
                value: ancestorStackWithValue({
                  value: ctx.mod.local.get(1, valueType),
                  ancestors: ctx.mod.local.get(2, stackType),
                  count: ctx.mod.local.get(3, binaryen.i32),
                  state,
                  ctx,
                  fnCtx,
                }),
                ctx,
                fnCtx,
              }),
              body,
            ],
            wasmTypeFor(state.resultTypeId, ctx),
          ),
        ),
      ],
      wasmTypeFor(state.resultTypeId, ctx),
    ),
  );
  state.activeHelpers.delete(schema.typeId);
  return name;
};

const registerSchema = ({
  schema,
  registry,
}: {
  schema: BoundarySchema;
  registry: Map<TypeId, BoundarySchema>;
}): void => {
  if (schema.kind !== "ref" && !registry.has(schema.typeId))
    registry.set(schema.typeId, schema);
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
  state: StreamWriterState;
  ctx: CodegenContext;
}): BoundarySchema => {
  const resolved =
    state.registry.get(schema.typeId) ??
    deriveBoundarySchema({ typeId: schema.typeId, ctx });
  if (resolved.kind === "ref")
    throw new Error(`unresolved recursive DTO reference ${schema.typeId}`);
  registerSchema({ schema: resolved, registry: state.registry });
  return resolved;
};

const ancestorStackType = ({
  state,
  ctx,
}: {
  state: StreamWriterState;
  ctx: CodegenContext;
}): binaryen.Type => {
  if (typeof state.ancestorStackType === "number")
    return state.ancestorStackType;
  state.ancestorStackType = defineArrayType(
    ctx.mod,
    binaryen.eqref,
    true,
    "__voyd_dto_stream_ancestor_stack",
  );
  return state.ancestorStackType;
};

const emptyAncestorStack = ({
  state,
  ctx,
}: {
  state: StreamWriterState;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const type = ancestorStackType({ state, ctx });
  return arrayNew(
    ctx.mod,
    binaryenTypeToHeapType(type),
    ctx.mod.i32.const(0),
    ctx.mod.ref.null(binaryen.eqref),
  );
};

const ancestorStackContains = ({
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
}): binaryen.ExpressionRef => {
  const index = allocateTempLocal(binaryen.i32, fnCtx);
  const found = allocateTempLocal(binaryen.i32, fnCtx);
  const indexRef = () => loadLocalValue(index, ctx);
  const foundRef = () => loadLocalValue(found, ctx);
  const label = freshLabel("dto_stream_ancestor_scan");
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
        label,
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
            ctx.mod.br(label),
          ]),
        ),
      ),
      foundRef(),
    ],
    binaryen.i32,
  );
};

const ancestorStackWithValue = ({
  value,
  ancestors,
  count,
  state,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  ancestors: binaryen.ExpressionRef;
  count: binaryen.ExpressionRef;
  state: StreamWriterState;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const type = ancestorStackType({ state, ctx });
  const next = allocateTempLocal(type, fnCtx);
  const index = allocateTempLocal(binaryen.i32, fnCtx);
  const nextRef = () => loadLocalValue(next, ctx);
  const indexRef = () => loadLocalValue(index, ctx);
  const label = freshLabel("dto_stream_ancestor_copy");
  return ctx.mod.block(
    null,
    [
      storeLocalValue({
        binding: next,
        value: arrayNew(
          ctx.mod,
          binaryenTypeToHeapType(type),
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
        label,
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
            ctx.mod.br(label),
          ]),
        ),
      ),
      arraySet(ctx.mod, nextRef(), count, value),
      nextRef(),
    ],
    type,
  );
};

let nextLabel = 0;
const freshLabel = (prefix: string): string => `${prefix}_${nextLabel++}`;
