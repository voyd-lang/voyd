export type DiagnosticSeverity = "error" | "warning" | "note";

export type DiagnosticPhase =
  | "module-graph"
  | "binder"
  | "typing"
  | "lowering"
  | "codegen";

export interface SourceSpan {
  file: string;
  start: number;
  end: number;
}

export interface DiagnosticHint {
  message: string;
  docLink?: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  severity: DiagnosticSeverity;
  span: SourceSpan;
  related?: readonly Diagnostic[];
  phase?: DiagnosticPhase;
  hints?: readonly DiagnosticHint[];
}

export type DiagnosticInput = {
  code: string;
  message: string;
  span: SourceSpan;
  severity?: DiagnosticSeverity;
  related?: readonly Diagnostic[];
  phase?: DiagnosticPhase;
  hints?: readonly DiagnosticHint[];
};
