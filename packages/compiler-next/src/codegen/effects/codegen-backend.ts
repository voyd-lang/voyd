import type binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ContinuationBinding,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
  HirExprId,
  HirEffectHandlerExpr,
  SymbolId,
  TypeId,
} from "../context.js";
import type { EffectLoweringResult } from "./effect-lowering.js";
import { createGcTrampolineBackend } from "./gc-trampoline-backend.js";

export type EffectsBackendKind = "gc-trampoline" | "stack-switch";

export interface EffectsBackend {
  kind: EffectsBackendKind;
  buildLowering: (params: {
    ctx: CodegenContext;
    siteCounter: { current: number };
  }) => EffectLoweringResult;
  lowerEffectfulCallResult: (params: {
    callExpr: binaryen.ExpressionRef;
    callId: HirExprId;
    returnTypeId: TypeId;
    expectedResultTypeId?: TypeId;
    tailPosition: boolean;
    typeInstanceKey?: string;
    ctx: CodegenContext;
    fnCtx: FunctionContext;
  }) => CompiledExpression;
  compileContinuationCall: (params: {
    expr: HirCallExpr;
    continuation: ContinuationBinding;
    ctx: CodegenContext;
    fnCtx: FunctionContext;
    compileExpr: ExpressionCompiler;
    expectedResultTypeId?: TypeId;
    tailPosition: boolean;
  }) => CompiledExpression;
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

const createStackSwitchBackend = (fallback: EffectsBackend): EffectsBackend => ({
  kind: "stack-switch",
  buildLowering: fallback.buildLowering,
  lowerEffectfulCallResult: fallback.lowerEffectfulCallResult,
  compileContinuationCall: fallback.compileContinuationCall,
  compileEffectOpCall: fallback.compileEffectOpCall,
  compileEffectHandlerExpr: fallback.compileEffectHandlerExpr,
});

export const selectEffectsBackend = (ctx: CodegenContext): EffectsBackend => {
  const fallback = createGcTrampolineBackend();
  const stackSwitching =
    ctx.options.continuationBackend.stackSwitching ??
    (typeof process !== "undefined" && process.env.VOYD_STACK_SWITCH === "1");
  if (stackSwitching) {
    // Stack-switching backend is not implemented yet; use gc-trampoline fallback.
    return createStackSwitchBackend(fallback);
  }
  return fallback;
};
