import type {
  HirEffectHandlerClause,
  HirEffectHandlerExpr,
  HirMethodParameter,
} from "../../semantics/hir/index.js";
import type { EffectRowId, HirExprId, SymbolId } from "../../semantics/ids.js";
import type { SemanticsPipelineResult } from "../context.js";

export type ContinuationMode = "gc-trampoline" | "stack-switch";

export interface ContinuationBackendOptions {
  stackSwitching?: boolean;
}

export interface EffectOperationInfo {
  symbol: SymbolId;
  effect?: SymbolId;
  resumable: "resume" | "tail";
  name: string;
}

export interface EffectContinuationRequest {
  opSymbol: SymbolId;
  effectSymbol?: SymbolId;
  resumable: "resume" | "tail";
  args: readonly unknown[];
  resume: (value: unknown) => ContinuationResult;
}

export type ContinuationResult =
  | { kind: "value"; value: unknown }
  | { kind: "return"; value: unknown }
  | { kind: "effect"; request: EffectContinuationRequest };

export interface ContinuationBackend {
  mode: ContinuationMode;
  run(params: { symbol: SymbolId; args?: readonly unknown[] }): unknown;
  runByName(params: { name: string; args?: readonly unknown[] }): unknown;
}

export interface EffectMirFunction {
  symbol: SymbolId;
  effectRow: EffectRowId;
  pure: boolean;
}

export interface EffectMirCall {
  expr: HirExprId;
  callee?: SymbolId;
  effectRow: EffectRowId;
  effectful: boolean;
}

export interface EffectMirHandlerClause {
  operation: SymbolId;
  effect?: SymbolId;
  resumeKind: "resume" | "tail";
  parameters: readonly HirMethodParameter[];
  body: HirExprId;
  tailResumption?: HirEffectHandlerClause["tailResumption"];
}

export interface EffectMirHandler {
  expr: HirEffectHandlerExpr;
  effectRow: EffectRowId;
  clauses: readonly EffectMirHandlerClause[];
  finallyBranch?: HirExprId;
}

export interface EffectMir {
  functions: Map<SymbolId, EffectMirFunction>;
  operations: Map<SymbolId, EffectOperationInfo>;
  handlers: Map<HirExprId, EffectMirHandler>;
  calls: Map<HirExprId, EffectMirCall>;
  handlerTails: Map<
    HirEffectHandlerClause["body"],
    HirEffectHandlerClause["tailResumption"]
  >;
  semantics: SemanticsPipelineResult;
  stackSwitching: boolean;
}
