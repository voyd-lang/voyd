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
  name,
  params,
  result,
  body,
  mod,
}: {
  name: string;
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  body: binaryen.ExpressionRef;
  mod: binaryen.Module;
}) => {
  mod.addFunction(
    name,
    binaryen.createType(params as number[]),
    result,
    [],
    body
  );
  mod.addFunctionExport(name, name);
};

export const addEffectRuntimeHelpers = (ctx: CodegenContext): void => {
  const { mod, effectsRuntime } = ctx;
  const outcomeType = effectsRuntime.outcomeType;

  addExportedFunction({
    name: OUTCOME_TAG_HELPER,
    params: [outcomeType],
    result: binaryen.i32,
    body: effectsRuntime.outcomeTag(mod.local.get(0, outcomeType)),
    mod,
  });

  addExportedFunction({
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
    mod,
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
    name: EFFECT_ID_HELPER,
    params: [outcomeType],
    result: binaryen.i32,
    body: requestField(effectsRuntime.requestEffectId),
    mod,
  });

  addExportedFunction({
    name: EFFECT_OP_ID_HELPER,
    params: [outcomeType],
    result: binaryen.i32,
    body: requestField(effectsRuntime.requestOpId),
    mod,
  });

  addExportedFunction({
    name: EFFECT_RESUME_KIND_HELPER,
    params: [outcomeType],
    result: binaryen.i32,
    body: requestField(effectsRuntime.requestResumeKind),
    mod,
  });
};
