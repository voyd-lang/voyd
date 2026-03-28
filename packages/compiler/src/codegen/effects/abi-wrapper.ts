import binaryen from "binaryen";
import type { CodegenContext } from "../context.js";
import {
  allocateTempLocal,
  loadLocalValue,
  storeLocalValue,
} from "../locals.js";
import { unboxOutcomeValue } from "./outcome-values.js";
import { ensureDispatcher } from "./dispatcher.js";
import { OUTCOME_TAGS } from "./runtime-abi.js";

export const emitPureSurfaceWrapper = (params: {
  ctx: CodegenContext;
  wrapperName: string;
  wrapperParamTypes: readonly binaryen.Type[];
  wrapperResultType: binaryen.Type;
  wrapperResultTypeId?: number;
  implName: string;
  buildImplCallArgs: () => readonly binaryen.ExpressionRef[];
}): void => {
  const {
    ctx,
    wrapperName,
    wrapperParamTypes,
    wrapperResultType,
    wrapperResultTypeId,
    implName,
    buildImplCallArgs,
  } = params;

  const wrapperCtx = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals: [] as binaryen.Type[],
    nextLocalIndex: wrapperParamTypes.length,
    returnTypeId: ctx.program.primitives.unknown,
    instanceId: undefined,
    typeInstanceId: undefined,
    effectful: false,
  };

  const outcomeTemp = allocateTempLocal(ctx.effectsRuntime.outcomeType, wrapperCtx);
  const resultTemp =
    wrapperResultType === binaryen.none
      ? undefined
      : allocateTempLocal(
          wrapperResultType,
          wrapperCtx,
          wrapperResultTypeId,
          ctx,
        );
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
  const payloadIsNull = ctx.mod.ref.is_null(payload());

  const wrapperBody = ctx.mod.block(
    null,
    [
      ctx.mod.local.set(outcomeTemp.index, dispatchedOutcome),
      ctx.mod.if(
        tagIsValue,
        resultTemp
          ? ctx.mod.if(
              payloadIsNull,
              ctx.mod.unreachable(),
              storeLocalValue({
                binding: resultTemp,
                value: unboxOutcomeValue({
                  payload: payload(),
                  valueType: wrapperResultType,
                  ctx,
                }),
                ctx,
                fnCtx: wrapperCtx,
              }),
            )
          : unboxOutcomeValue({
              payload: payload(),
              valueType: wrapperResultType,
              ctx,
            }),
        ctx.mod.unreachable()
      ),
      ...(resultTemp
        ? [loadLocalValue(resultTemp, ctx)]
        : []),
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
