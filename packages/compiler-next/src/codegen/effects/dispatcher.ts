import binaryen from "binaryen";
import { callRef, refCast } from "@voyd/lib/binaryen-gc/index.js";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import type { CodegenContext } from "../context.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export const ensureDispatcher = (ctx: CodegenContext): string => {
  const existing = ctx.effectsState.dispatcherName;
  if (existing) return existing;
  const fnName = "__voyd_dispatch";
  const handlerType = ctx.effectsRuntime.handlerFrameType;
  const outcomeType = ctx.effectsRuntime.outcomeType;
  const requestType = ctx.effectsRuntime.effectRequestType;

  const params = binaryen.createType([handlerType, outcomeType]);
  const locals = [binaryen.eqref, requestType, outcomeType];
  const frameLocal = 0;
  const requestLocal = 1;
  const outcomeLocal = 2;
  const loopLabel = "voyd_dispatch_loop";
  const loadFrame = () => ctx.mod.local.get(frameLocal + 2, binaryen.eqref);
  const loadOutcome = () => ctx.mod.local.get(outcomeLocal + 2, outcomeType);
  const loadRequest = () => ctx.mod.local.get(requestLocal + 2, requestType);
  const clauseFnType = (() => {
    const tempName = "__voyd_dispatch_sig";
    const temp = ctx.mod.addFunction(
      tempName,
      binaryen.createType([handlerType, binaryen.anyref, requestType]),
      outcomeType,
      [],
      ctx.mod.nop()
    );
    const fnType = bin._BinaryenTypeFromHeapType(
      bin._BinaryenFunctionGetType(temp),
      false
    );
    ctx.mod.removeFunction(tempName);
    return fnType;
  })();

  const matchFields = (): binaryen.ExpressionRef => {
    const typedFrame = refCast(ctx.mod, loadFrame(), handlerType);
    const effectMatches = ctx.mod.i32.eq(
      ctx.effectsRuntime.handlerEffectId(typedFrame),
      ctx.effectsRuntime.requestEffectId(loadRequest())
    );
    const opMatches = ctx.mod.i32.eq(
      ctx.effectsRuntime.handlerOpId(typedFrame),
      ctx.effectsRuntime.requestOpId(loadRequest())
    );
    const resumeMatches = ctx.mod.i32.eq(
      ctx.effectsRuntime.handlerResumeKind(typedFrame),
      ctx.effectsRuntime.requestResumeKind(loadRequest())
    );
    return ctx.mod.i32.and(
      ctx.mod.i32.and(effectMatches, opMatches),
      resumeMatches
    );
  };

  const frameLoopLabel = "voyd_dispatch_frame";
  const frameLoop = ctx.mod.loop(
    frameLoopLabel,
    ctx.mod.block(null, [
      ctx.mod.if(
        ctx.mod.ref.is_null(loadFrame()),
        ctx.mod.return(loadOutcome()),
        ctx.mod.nop()
      ),
      ctx.mod.if(
        matchFields(),
        ctx.mod.block(null, [
          ctx.mod.local.set(
            outcomeLocal + 2,
            callRef(
              ctx.mod,
              refCast(
                ctx.mod,
                ctx.effectsRuntime.handlerClauseFn(
                  refCast(ctx.mod, loadFrame(), handlerType)
                ),
                clauseFnType
              ),
              [
                ctx.mod.local.get(0, handlerType),
                ctx.effectsRuntime.handlerClauseEnv(
                  refCast(ctx.mod, loadFrame(), handlerType)
                ),
                loadRequest(),
              ] as number[],
              outcomeType
            )
          ),
          ctx.mod.br(loopLabel),
        ]),
        ctx.mod.nop()
      ),
      ctx.mod.local.set(
        frameLocal + 2,
        ctx.effectsRuntime.handlerPrev(
          refCast(ctx.mod, loadFrame(), handlerType)
        )
      ),
      ctx.mod.br(frameLoopLabel),
    ])
  );

  const loopBody = ctx.mod.block(null, [
    ctx.mod.if(
      ctx.mod.i32.eq(
        ctx.effectsRuntime.outcomeTag(loadOutcome()),
        ctx.mod.i32.const(0)
      ),
      ctx.mod.return(loadOutcome()),
      ctx.mod.nop()
    ),
    ctx.mod.local.set(
      requestLocal + 2,
      refCast(
        ctx.mod,
        ctx.effectsRuntime.outcomePayload(loadOutcome()),
        requestType
      )
    ),
    ctx.mod.local.set(frameLocal + 2, ctx.mod.local.get(0, handlerType)),
    frameLoop,
  ]);

  ctx.mod.addFunction(
    fnName,
    params,
    outcomeType,
    locals,
    ctx.mod.block(null, [
      ctx.mod.local.set(frameLocal + 2, ctx.mod.local.get(0, handlerType)),
      ctx.mod.local.set(outcomeLocal + 2, ctx.mod.local.get(1, outcomeType)),
      ctx.mod.loop(loopLabel, loopBody),
    ])
  );

  ctx.effectsState.dispatcherName = fnName;
  return fnName;
};
