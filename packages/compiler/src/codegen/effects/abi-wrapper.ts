import binaryen from "binaryen";
import type { CodegenContext } from "../context.js";
import { allocateTempLocal } from "../locals.js";
import { unboxOutcomeValue } from "./outcome-values.js";
import { ensureDispatcher } from "./dispatcher.js";
import { OUTCOME_TAGS } from "./runtime-abi.js";

export const emitPureSurfaceWrapper = (params: {
  ctx: CodegenContext;
  wrapperName: string;
  wrapperParamTypes: readonly binaryen.Type[];
  wrapperResultType: binaryen.Type;
  implName: string;
  buildImplCallArgs: () => readonly binaryen.ExpressionRef[];
}): void => {
  const {
    ctx,
    wrapperName,
    wrapperParamTypes,
    wrapperResultType,
    implName,
    buildImplCallArgs,
  } = params;

  const wrapperCtx = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals: [] as binaryen.Type[],
    nextLocalIndex: wrapperParamTypes.length,
    returnTypeId: ctx.program.primitives.unknown,
    instanceKey: undefined,
    typeInstanceKey: undefined,
    effectful: false,
  };

  const outcomeTemp = allocateTempLocal(ctx.effectsRuntime.outcomeType, wrapperCtx);
  const loadOutcome = () =>
    ctx.mod.local.get(outcomeTemp.index, ctx.effectsRuntime.outcomeType);
  const payload = () => ctx.effectsRuntime.outcomePayload(loadOutcome());

  const dispatchedOutcome = ctx.mod.call(
    ensureDispatcher(ctx),
    [
      ctx.mod.call(
        implName,
        buildImplCallArgs() as number[],
        ctx.effectsRuntime.outcomeType
      ),
    ],
    ctx.effectsRuntime.outcomeType
  );

  const tagIsValue = ctx.mod.i32.eq(
    ctx.effectsRuntime.outcomeTag(loadOutcome()),
    ctx.mod.i32.const(OUTCOME_TAGS.value)
  );

  const wrapperBody = ctx.mod.block(
    null,
    [
      ctx.mod.local.set(outcomeTemp.index, dispatchedOutcome),
      ctx.mod.if(
        tagIsValue,
        unboxOutcomeValue({
          payload: payload(),
          valueType: wrapperResultType,
          ctx,
        }),
        ctx.mod.unreachable()
      ),
    ],
    wrapperResultType
  );

  ctx.mod.addFunction(
    wrapperName,
    binaryen.createType(wrapperParamTypes as number[]),
    wrapperResultType,
    wrapperCtx.locals,
    wrapperBody
  );
};
