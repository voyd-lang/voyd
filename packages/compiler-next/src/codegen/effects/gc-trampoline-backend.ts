import { compileEffectHandlerExpr } from "../expressions/effect-handler.js";
import { buildEffectLowering } from "./effect-lowering.js";
import type { EffectsBackend } from "./codegen-backend.js";
import { compileContinuationCall } from "./gc-trampoline/continuation-call.js";
import { lowerEffectfulCallResult } from "./gc-trampoline/lower-effectful-call.js";
import { compileEffectOpCall } from "./gc-trampoline/perform.js";

export const createGcTrampolineBackend = (): EffectsBackend => ({
  kind: "gc-trampoline",
  buildLowering: ({ ctx, siteCounter }) => buildEffectLowering({ ctx, siteCounter }),
  lowerEffectfulCallResult: (params) => lowerEffectfulCallResult(params),
  compileContinuationCall: (params) => compileContinuationCall(params),
  compileEffectOpCall: (params) => compileEffectOpCall(params),
  compileEffectHandlerExpr: ({
    expr,
    ctx,
    fnCtx,
    compileExpr,
    tailPosition,
    expectedResultTypeId,
  }) =>
    compileEffectHandlerExpr(
      expr,
      ctx,
      fnCtx,
      compileExpr,
      tailPosition,
      expectedResultTypeId
    ),
});

