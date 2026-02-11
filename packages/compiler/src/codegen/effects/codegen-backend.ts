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
  FunctionMetadata,
} from "../context.js";
import type { ProgramFunctionInstanceId } from "../../semantics/ids.js";
import type { EffectLoweringResult } from "./effect-lowering.js";
import { createGcTrampolineBackend } from "./gc-trampoline-backend.js";

export type EffectsBackendKind = "gc-trampoline" | "stack-switch";

export type EffectfulExportTarget = {
  meta: FunctionMetadata;
  exportName: string;
};

export interface EffectAbiSignature {
  paramTypes: readonly binaryen.Type[];
  resultType: binaryen.Type;
  userParamOffset: number;
}

export interface EffectsAbiStrategy {
  hiddenHandlerParamType: (ctx: CodegenContext) => binaryen.Type;
  hiddenHandlerValue: (ctx: CodegenContext) => binaryen.ExpressionRef;
  effectfulResultType: (ctx: CodegenContext) => binaryen.Type;
  widenSignature: (params: {
    ctx: CodegenContext;
    effectful: boolean;
    userParamTypes: readonly binaryen.Type[];
    userResultType: binaryen.Type;
  }) => EffectAbiSignature;
  emitHostBoundary: (params: {
    entryCtx: CodegenContext;
    contexts: readonly CodegenContext[];
    effectfulExports: readonly EffectfulExportTarget[];
  }) => void;
}

export interface EffectsBackend {
  kind: EffectsBackendKind;
  requestedKind: EffectsBackendKind;
  stackSwitchRequested: boolean;
  stackSwitchUnavailableReason?: string;
  abi: EffectsAbiStrategy;
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
    typeInstanceId?: ProgramFunctionInstanceId;
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

export const STACK_SWITCH_UNAVAILABLE_REASON =
  "stack-switch backend is not implemented yet";

const stackSwitchRequestedFor = (ctx: CodegenContext): boolean =>
  ctx.options.continuationBackend.stackSwitching ??
  (typeof process !== "undefined" && process.env.VOYD_STACK_SWITCH === "1");

export const selectEffectsBackend = (ctx: CodegenContext): EffectsBackend => {
  const stackSwitchRequested = stackSwitchRequestedFor(ctx);
  return createGcTrampolineBackend({
    requestedKind: stackSwitchRequested ? "stack-switch" : "gc-trampoline",
    stackSwitchRequested,
    stackSwitchUnavailableReason: stackSwitchRequested
      ? STACK_SWITCH_UNAVAILABLE_REASON
      : undefined,
  });
};
