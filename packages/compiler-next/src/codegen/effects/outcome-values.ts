import binaryen from "binaryen";
import {
  defineStructType,
  initStruct,
  refCast,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import type { CodegenContext } from "../context.js";

export interface OutcomeValueBox {
  key: string;
  boxType: binaryen.Type;
  valueType: binaryen.Type;
}

const valueTypeKey = (valueType: binaryen.Type): string => `${valueType}`;

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const ensureOutcomeValueBox = ({
  valueType,
  ctx,
}: {
  valueType: binaryen.Type;
  ctx: CodegenContext;
}): OutcomeValueBox => {
  const key = valueTypeKey(valueType);
  const cached = ctx.outcomeValueTypes.get(key);
  if (cached) return cached;

  const boxType = defineStructType(ctx.mod, {
    name: `voydOutcomeValue_${sanitize(`${ctx.outcomeValueTypes.size}_${key}`)}`,
    fields: [{ name: "value", type: valueType, mutable: false }],
    final: true,
  });

  const box: OutcomeValueBox = { key, boxType, valueType };
  ctx.outcomeValueTypes.set(key, box);
  return box;
};

export const getOutcomeValueBoxType = ({
  valueType,
  ctx,
}: {
  valueType: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.Type => ensureOutcomeValueBox({ valueType, ctx }).boxType;

export const boxOutcomeValue = ({
  value,
  valueType,
  ctx,
}: {
  value: binaryen.ExpressionRef;
  valueType: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (valueType === binaryen.none) {
    return ctx.mod.ref.null(binaryen.eqref);
  }

  const box = ensureOutcomeValueBox({ valueType, ctx });
  return initStruct(ctx.mod, box.boxType, [value]);
};

export const unboxOutcomeValue = ({
  payload,
  valueType,
  ctx,
}: {
  payload: binaryen.ExpressionRef;
  valueType: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (valueType === binaryen.none) {
    return ctx.mod.block(null, [ctx.mod.drop(payload)], binaryen.none);
  }

  const box = ensureOutcomeValueBox({ valueType, ctx });
  return structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: 0,
    fieldType: valueType,
    exprRef: refCast(ctx.mod, payload, box.boxType),
  });
};

export const wrapValueInOutcome = ({
  valueExpr,
  valueType,
  ctx,
}: {
  valueExpr: binaryen.ExpressionRef;
  valueType: binaryen.Type;
  ctx: CodegenContext;
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

  const payload = boxOutcomeValue({ value: valueExpr, valueType, ctx });
  return ctx.effectsRuntime.makeOutcomeValue(payload);
};
