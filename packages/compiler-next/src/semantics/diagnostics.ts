import type { Diagnostic, DiagnosticSeverity, SourceSpan } from "./ids.js";

export type DiagnosticInput = {
  code: string;
  message: string;
  span: SourceSpan;
  severity?: DiagnosticSeverity;
  related?: readonly Diagnostic[];
};

export const createDiagnostic = ({
  severity,
  ...input
}: DiagnosticInput): Diagnostic => ({
  ...input,
  severity: severity ?? "error",
});

export const formatDiagnostic = (diagnostic: Diagnostic): string => {
  const location = `${diagnostic.span.file}:${diagnostic.span.start}-${diagnostic.span.end}`;
  const severity = diagnostic.severity.toUpperCase();
  return `${location} ${severity} ${diagnostic.code}: ${diagnostic.message}`;
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
