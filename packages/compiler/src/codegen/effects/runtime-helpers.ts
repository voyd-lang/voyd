import binaryen from "binaryen";
import { refCast } from "@voyd/lib/binaryen-gc/index.js";
import type { CodegenContext } from "../context.js";
import { unboxOutcomeValue } from "./outcome-values.js";

export const OUTCOME_TAG_HELPER = "__voyd_outcome_tag";
export const OUTCOME_UNWRAP_I32_HELPER = "__voyd_outcome_unwrap_i32";
export const EFFECT_ID_HELPER = "__voyd_effect_id";
export const EFFECT_OP_ID_HELPER = "__voyd_effect_op_id";
export const EFFECT_RESUME_KIND_HELPER = "__voyd_effect_resume_kind";

const addExportedFunction = ({
  ctx,
  name,
  params,
  result,
  body,
}: {
  ctx: CodegenContext;
  name: string;
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  body: binaryen.ExpressionRef;
}) => {
  if (ctx.programHelpers.hasHelper(name)) {
    return;
  }
  ctx.programHelpers.recordHelper(name);
  const { mod } = ctx;
  mod.addFunction(
    name,
    binaryen.createType(params as number[]),
    result,
    [],
    body
  );
  if (ctx.programHelpers.registerExportName(name)) {
    mod.addFunctionExport(name, name);
  }
};

export const addEffectRuntimeHelpers = (ctx: CodegenContext): void => {
  const { mod, effectsRuntime } = ctx;
  const outcomeType = effectsRuntime.outcomeType;

  addExportedFunction({
    ctx,
    name: OUTCOME_TAG_HELPER,
    params: [outcomeType],
    result: binaryen.i32,
    body: effectsRuntime.outcomeTag(mod.local.get(0, outcomeType)),
  });

  addExportedFunction({
    ctx,
    name: OUTCOME_UNWRAP_I32_HELPER,
    params: [outcomeType],
    result: binaryen.i32,
    body: unboxOutcomeValue({
      payload: effectsRuntime.outcomePayload(
        mod.local.get(0, outcomeType)
      ),
      valueType: binaryen.i32,
      ctx,
    }),
  });

  const requestField = (
    read: (request: binaryen.ExpressionRef) => binaryen.ExpressionRef
  ): binaryen.ExpressionRef =>
    read(
      refCast(
        mod,
        effectsRuntime.outcomePayload(mod.local.get(0, outcomeType)),
        effectsRuntime.effectRequestType
      )
    );

  addExportedFunction({
    ctx,
    name: EFFECT_ID_HELPER,
    params: [outcomeType],
    result: binaryen.i64,
    body: requestField(effectsRuntime.requestEffectId),
  });

  addExportedFunction({
    ctx,
    name: EFFECT_OP_ID_HELPER,
    params: [outcomeType],
    result: binaryen.i32,
    body: requestField(effectsRuntime.requestOpId),
  });

  addExportedFunction({
    ctx,
    name: EFFECT_RESUME_KIND_HELPER,
    params: [outcomeType],
    result: binaryen.i32,
    body: requestField(effectsRuntime.requestResumeKind),
  });
};
