import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
  HirEffectHandlerExpr,
  SymbolId,
  TypeId,
} from "../context.js";
import type { EffectLoweringResult } from "./effect-lowering.js";
import { buildEffectLowering } from "./effect-lowering.js";
import { compileEffectOpCall } from "../expressions/calls.js";
import { compileEffectHandlerExpr } from "../expressions/effect-handler.js";

export type EffectsBackendKind = "gc-trampoline" | "stack-switch";

export interface EffectsBackend {
  kind: EffectsBackendKind;
  buildLowering: (params: {
    ctx: CodegenContext;
    siteCounter: { current: number };
  }) => EffectLoweringResult;
  compileEffectOpCall: (params: {
    expr: HirCallExpr;
    calleeSymbol: SymbolId;
    ctx: CodegenContext;
    fnCtx: FunctionContext;
    compileExpr: ExpressionCompiler;
  }) => CompiledExpression;
  compileEffectHandlerExpr: (params: {
    expr: HirEffectHandlerExpr;
    ctx: CodegenContext;
    fnCtx: FunctionContext;
    compileExpr: ExpressionCompiler;
    tailPosition: boolean;
    expectedResultTypeId?: TypeId;
  }) => CompiledExpression;
}

const createGcTrampolineBackend = (): EffectsBackend => ({
  kind: "gc-trampoline",
  buildLowering: ({ ctx, siteCounter }) =>
    buildEffectLowering({ ctx, siteCounter }),
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

const createStackSwitchBackend = (fallback: EffectsBackend): EffectsBackend => ({
  kind: "stack-switch",
  buildLowering: fallback.buildLowering,
  compileEffectOpCall: fallback.compileEffectOpCall,
  compileEffectHandlerExpr: fallback.compileEffectHandlerExpr,
});

export const selectEffectsBackend = (ctx: CodegenContext): EffectsBackend => {
  const fallback = createGcTrampolineBackend();
  if (ctx.effectMir.stackSwitching) {
    // Stack-switching backend is not implemented yet; use gc-trampoline fallback.
    return createStackSwitchBackend(fallback);
  }
  return fallback;
};

