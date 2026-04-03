import binaryen from "binaryen";
import {
  defineStructType,
  initStruct,
  refCast,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type { CodegenContext, FunctionContext, TypeId } from "../context.js";
import { captureMultivalueLanes } from "../multivalue.js";

export interface OutcomeValueBox {
  key: string;
  boxType: binaryen.Type;
  valueType: binaryen.Type;
  abiTypes: readonly binaryen.Type[];
  storageTypes: readonly binaryen.Type[];
  markerValue?: number;
}

const valueTypeKey = ({
  valueType,
  typeId,
  ctx,
}: {
  valueType: binaryen.Type;
  typeId?: TypeId;
  ctx: CodegenContext;
}): string =>
  typeId === ctx.program.primitives.bool ? `bool:${valueType}` : `${valueType}`;

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const expandValueType = (valueType: binaryen.Type): binaryen.Type[] =>
  valueType === binaryen.none ? [] : [...binaryen.expandType(valueType)];

const makeInlineValue = ({
  values,
  ctx,
}: {
  values: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (values.length === 0) {
    return ctx.mod.nop();
  }
  if (values.length === 1) {
    return values[0]!;
  }
  return ctx.mod.tuple.make(values as binaryen.ExpressionRef[]);
};

const ensureOutcomeValueBox = ({
  valueType,
  typeId,
  ctx,
}: {
  valueType: binaryen.Type;
  typeId?: TypeId;
  ctx: CodegenContext;
}): OutcomeValueBox => {
  const key = valueTypeKey({ valueType, typeId, ctx });
  const cached = ctx.outcomeValueTypes.get(key);
  if (cached) return cached;
  const abiTypes = expandValueType(valueType);
  const markerValue = typeId === ctx.program.primitives.bool ? 1 : undefined;
  const storageTypes =
    typeof markerValue === "number" ? [...abiTypes, binaryen.i32] : abiTypes;

  const boxType = defineStructType(ctx.mod, {
    name: `voydOutcomeValue_${sanitize(`${ctx.outcomeValueTypes.size}_${key}`)}`,
    fields: storageTypes.map((type, index) => ({
      name:
        index < abiTypes.length
          ? abiTypes.length === 1
            ? "value"
            : `v${index}`
          : "marker",
      type,
      mutable: false,
    })),
    final: true,
  });

  const box: OutcomeValueBox = {
    key,
    boxType,
    valueType,
    abiTypes,
    storageTypes,
    markerValue,
  };
  ctx.outcomeValueTypes.set(key, box);
  return box;
};

export const getOutcomeValueBoxType = ({
  valueType,
  typeId,
  ctx,
}: {
  valueType: binaryen.Type;
  typeId?: TypeId;
  ctx: CodegenContext;
}): binaryen.Type => ensureOutcomeValueBox({ valueType, typeId, ctx }).boxType;

export const boxOutcomeValue = ({
  value,
  valueType,
  typeId,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  valueType: binaryen.Type;
  typeId?: TypeId;
  ctx: CodegenContext;
  fnCtx?: Pick<FunctionContext, "locals" | "nextLocalIndex">;
}): binaryen.ExpressionRef => {
  if (valueType === binaryen.none) {
    return ctx.mod.ref.null(binaryen.eqref);
  }

  const box = ensureOutcomeValueBox({ valueType, typeId, ctx });
  if (box.abiTypes.length === 1) {
    return initStruct(ctx.mod, box.boxType, [
      value,
      ...(typeof box.markerValue === "number"
        ? [ctx.mod.i32.const(box.markerValue)]
        : []),
    ]);
  }
  if (!fnCtx) {
    throw new Error("boxing multivalue outcome requires local scratch storage");
  }
  const captured = captureMultivalueLanes({
    value,
    abiTypes: box.abiTypes,
    ctx,
    fnCtx: fnCtx as FunctionContext,
  });
  const boxed = initStruct(
    ctx.mod,
    box.boxType,
    [
      ...(captured.lanes as binaryen.ExpressionRef[]),
      ...(typeof box.markerValue === "number"
        ? [ctx.mod.i32.const(box.markerValue)]
        : []),
    ],
  );
  if (captured.setup.length === 0) {
    return boxed;
  }
  return ctx.mod.block(null, [...captured.setup, boxed], box.boxType);
};

export const unboxOutcomeValue = ({
  payload,
  valueType,
  typeId,
  ctx,
}: {
  payload: binaryen.ExpressionRef;
  valueType: binaryen.Type;
  typeId?: TypeId;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (valueType === binaryen.none) {
    return ctx.mod.block(null, [ctx.mod.drop(payload)], binaryen.none);
  }

  const box = ensureOutcomeValueBox({ valueType, typeId, ctx });
  if (box.abiTypes.length === 1) {
    return structGetFieldValue({
      mod: ctx.mod,
      fieldIndex: 0,
      fieldType: valueType,
      exprRef: refCast(ctx.mod, payload, box.boxType),
    });
  }
  return makeInlineValue({
    values: box.abiTypes.map((abiType, index) =>
      structGetFieldValue({
        mod: ctx.mod,
        fieldIndex: index,
        fieldType: abiType,
        exprRef: refCast(ctx.mod, payload, box.boxType),
      }),
    ),
    ctx,
  });
};

export const wrapValueInOutcome = ({
  valueExpr,
  valueType,
  typeId,
  ctx,
  fnCtx,
}: {
  valueExpr: binaryen.ExpressionRef;
  valueType: binaryen.Type;
  typeId?: TypeId;
  ctx: CodegenContext;
  fnCtx?: Pick<FunctionContext, "locals" | "nextLocalIndex">;
}): binaryen.ExpressionRef => {
  if (valueType === binaryen.none) {
    return ctx.mod.block(
      null,
      [
        valueExpr,
        ctx.effectsRuntime.makeOutcomeValue(ctx.mod.ref.null(binaryen.eqref)),
      ],
      ctx.effectsRuntime.outcomeType
    );
  }

  const payload = boxOutcomeValue({ value: valueExpr, valueType, typeId, ctx, fnCtx });
  return ctx.effectsRuntime.makeOutcomeValue(payload);
};

export const isOutcomeCarrierType = ({
  wasmType,
  ctx,
}: {
  wasmType: binaryen.Type;
  ctx: CodegenContext;
}): boolean =>
  wasmType === ctx.effectsRuntime.outcomeType ||
  wasmType === ctx.effectsBackend.abi.effectfulResultType(ctx);
