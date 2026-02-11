import { compileEffectHandlerExpr } from "../expressions/effect-handler.js";
import {
  buildEffectLoweringEir,
  materializeGcTrampolineEffectLowering,
} from "./effect-lowering.js";
import type { EffectsBackend } from "./codegen-backend.js";
import { gcTrampolineAbiStrategy } from "./gc-trampoline-abi-strategy.js";
import { compileContinuationCall } from "./gc-trampoline/continuation-call.js";
import { lowerEffectfulCallResult } from "./gc-trampoline/lower-effectful-call.js";
import { compileEffectOpCall } from "./gc-trampoline/perform.js";

export const createGcTrampolineBackend = ({
  requestedKind = "gc-trampoline",
  stackSwitchRequested = false,
  stackSwitchUnavailableReason,
}: {
  requestedKind?: "gc-trampoline" | "stack-switch";
  stackSwitchRequested?: boolean;
  stackSwitchUnavailableReason?: string;
} = {}): EffectsBackend => ({
  kind: "gc-trampoline",
  requestedKind,
  stackSwitchRequested,
  stackSwitchUnavailableReason,
  abi: gcTrampolineAbiStrategy,
  buildLowering: ({ ctx, siteCounter }) =>
    materializeGcTrampolineEffectLowering({
      eir: buildEffectLoweringEir({ ctx, siteCounter }),
      ctx,
    }),
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
