import {
  DiagnosticError,
  diagnosticFromCode,
  type Diagnostic,
} from "@voyd/compiler/diagnostics/index.js";

export const normalizeErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isDiagnostic = (value: unknown): value is Diagnostic => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<Diagnostic>;
  const span = candidate.span as
    | { file?: unknown; start?: unknown; end?: unknown }
    | undefined;

  return Boolean(
    typeof candidate.code === "string" &&
      typeof candidate.message === "string" &&
      span &&
      typeof span.file === "string" &&
      typeof span.start === "number" &&
      typeof span.end === "number",
  );
};

const extractDiagnostic = (error: unknown): Diagnostic | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  if (!("diagnostic" in error)) {
    return undefined;
  }

  const value = (error as { diagnostic?: unknown }).diagnostic;
  return isDiagnostic(value) ? value : undefined;
};

const extractDiagnostics = (error: unknown): Diagnostic[] | undefined => {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  if (!("diagnostics" in error)) {
    return undefined;
  }

  const values = (error as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(values)) {
    return undefined;
  }

  const diagnostics = values.filter((value): value is Diagnostic =>
    isDiagnostic(value),
  );
  return diagnostics.length > 0 ? diagnostics : undefined;
};

export const createUnexpectedDiagnostic = ({
  message,
  file,
}: {
  message: string;
  file: string;
}): Diagnostic =>
  diagnosticFromCode({
    code: "TY9999",
    params: {
      kind: "unexpected-error",
      message,
    },
    span: {
      file,
      start: 0,
      end: 0,
    },
  });

export const diagnosticsFromUnknownError = ({
  error,
  fallbackFile,
}: {
  error: unknown;
  fallbackFile: string;
}): Diagnostic[] => {
  if (error instanceof DiagnosticError) {
    return [...error.diagnostics];
  }

  if (isDiagnostic(error)) {
    return [error];
  }

  const diagnostic = extractDiagnostic(error);
  if (diagnostic) {
    return [diagnostic];
  }

  const diagnostics = extractDiagnostics(error);
  if (diagnostics) {
    return diagnostics;
  }

  return [
    createUnexpectedDiagnostic({
      message: normalizeErrorMessage(error),
      file: fallbackFile,
    }),
  ];
};
