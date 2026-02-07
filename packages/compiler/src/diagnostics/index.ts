export * from "./types.js";
export * from "./registry.js";

import {
  type Diagnostic,
  type DiagnosticHint,
  type DiagnosticInput,
  type DiagnosticPhase,
  type DiagnosticSeverity,
  type SourceSpan,
} from "./types.js";
import {
  formatDiagnosticMessage,
  getDiagnosticDefinition,
  type DiagnosticCode,
  type DiagnosticParams,
} from "./registry.js";

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

type RegistryDiagnosticOptions<K extends DiagnosticCode> = {
  code: K;
  params: DiagnosticParams<K>;
  span: SourceSpan;
  related?: readonly Diagnostic[];
  severity?: DiagnosticSeverity;
  phase?: DiagnosticPhase;
  hints?: readonly DiagnosticHint[];
};

export const diagnosticFromCode = <K extends DiagnosticCode>(
  options: RegistryDiagnosticOptions<K>
): Diagnostic => {
  const definition = getDiagnosticDefinition(options.code);
  return createDiagnostic({
    code: options.code,
    message: formatDiagnosticMessage(options.code, options.params),
    span: options.span,
    related: options.related,
    severity: options.severity ?? definition.severity,
    phase: options.phase ?? definition.phase,
    hints: options.hints ?? definition.hints,
  });
};

type DiagnosticsCarrier = DiagnosticEmitter | { diagnostics: DiagnosticEmitter };

export type EmitDiagnosticOptions<K extends DiagnosticCode> =
  RegistryDiagnosticOptions<K> & { ctx: DiagnosticsCarrier };

const getEmitter = (carrier: DiagnosticsCarrier): DiagnosticEmitter =>
  "report" in carrier ? carrier : carrier.diagnostics;

export const emitDiagnostic = <K extends DiagnosticCode>(
  options: EmitDiagnosticOptions<K>
): never => {
  const { ctx, ...rest } = options;
  return getEmitter(ctx).error(diagnosticFromCode(rest));
};

export const formatDiagnostic = (diagnostic: Diagnostic): string => {
  const location = `${diagnostic.span.file}:${diagnostic.span.start}-${diagnostic.span.end}`;
  const severity = diagnostic.severity.toUpperCase();
  const phase = diagnostic.phase ? `[${diagnostic.phase}] ` : "";
  return `${location} ${severity} ${phase}${diagnostic.code}: ${diagnostic.message}`;
};

export class DiagnosticError extends Error {
  diagnostic: Diagnostic;
  diagnostics: readonly Diagnostic[];

  constructor(diagnostic: Diagnostic, diagnostics?: readonly Diagnostic[]) {
    super(formatDiagnostic(diagnostic));
    this.diagnostic = diagnostic;
    this.diagnostics =
      diagnostics && diagnostics.length > 0
        ? [...diagnostics]
        : [diagnostic];
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
    throw new DiagnosticError(diagnostic, this.#diagnostics);
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
