import type { SymbolId } from "../../semantics/ids.js";

export type ContinuationMode = "gc-trampoline" | "stack-switch";

export interface ContinuationBackendOptions {
  stackSwitching?: boolean;
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
