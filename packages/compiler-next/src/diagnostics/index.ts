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

export interface Diagnostic {
  code: string;
  message: string;
  severity: DiagnosticSeverity;
  span: SourceSpan;
  related?: readonly Diagnostic[];
  phase?: DiagnosticPhase;
}

export type DiagnosticInput = {
  code: string;
  message: string;
  span: SourceSpan;
  severity?: DiagnosticSeverity;
  related?: readonly Diagnostic[];
  phase?: DiagnosticPhase;
};

const codePhasePrefixes: Record<string, DiagnosticPhase> = {
  MD: "module-graph",
  BD: "binder",
  TY: "typing",
  LW: "lowering",
  CG: "codegen",
};

const inferPhase = (code: string): DiagnosticPhase | undefined => {
  const prefix = code.slice(0, 2).toUpperCase();
  return codePhasePrefixes[prefix];
};

export const createDiagnostic = ({
  severity,
  phase,
  ...input
}: DiagnosticInput): Diagnostic => ({
  ...input,
  severity: severity ?? "error",
  phase: phase ?? inferPhase(input.code),
});

export const formatDiagnostic = (diagnostic: Diagnostic): string => {
  const location = `${diagnostic.span.file}:${diagnostic.span.start}-${diagnostic.span.end}`;
  const severity = diagnostic.severity.toUpperCase();
  const phase = diagnostic.phase ? `[${diagnostic.phase}] ` : "";
  return `${location} ${severity} ${phase}${diagnostic.code}: ${diagnostic.message}`;
};

export class DiagnosticError extends Error {
  diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(formatDiagnostic(diagnostic));
    this.diagnostic = diagnostic;
  }
}

export class DiagnosticEmitter {
  #diagnostics: Diagnostic[] = [];

  report(input: DiagnosticInput): Diagnostic {
    const diagnostic = createDiagnostic(input);
    this.#diagnostics.push(diagnostic);
    return diagnostic;
  }

  error(input: DiagnosticInput): never {
    const diagnostic = this.report(input);
    throw new DiagnosticError(diagnostic);
  }

  get diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }
}

export const normalizeSpan = (
  ...candidates: (SourceSpan | undefined)[]
): SourceSpan => {
  for (const span of candidates) {
    if (span) return span;
  }
  return { file: "<unknown>", start: 0, end: 0 };
};
