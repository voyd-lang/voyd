import type { Diagnostic } from "@voyd/sdk/compiler";

export type DiagnosticsCompactionResult = {
  diagnostics: Diagnostic[];
  duplicateCount: number;
  cappedImportCount: number;
  suppressedCount: number;
};

const MAX_BD0001_DIAGNOSTICS = 20;
const IMPORT_DIAGNOSTIC_CODE = "BD0001";

const diagnosticKey = (diagnostic: Diagnostic): string =>
  [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.phase ?? "",
    diagnostic.span.file,
    diagnostic.span.start,
    diagnostic.span.end,
    diagnostic.message,
  ].join("|");

const dedupeDiagnostics = (diagnostics: readonly Diagnostic[]): Diagnostic[] => {
  const seen = new Set<string>();
  const deduped: Diagnostic[] = [];

  diagnostics.forEach((diagnostic) => {
    const key = diagnosticKey(diagnostic);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    deduped.push(diagnostic);
  });

  return deduped;
};

const compactImportDiagnostics = (
  diagnostics: readonly Diagnostic[],
): Diagnostic[] => {
  let keptImportDiagnostics = 0;
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.code !== IMPORT_DIAGNOSTIC_CODE) {
      return true;
    }

    if (keptImportDiagnostics >= MAX_BD0001_DIAGNOSTICS) {
      return false;
    }

    keptImportDiagnostics += 1;
    return true;
  });
};

export const compactDiagnosticsForCli = (
  diagnostics: readonly Diagnostic[],
): DiagnosticsCompactionResult => {
  const deduped = dedupeDiagnostics(diagnostics);
  const compacted = compactImportDiagnostics(deduped);

  const duplicateCount = diagnostics.length - deduped.length;
  const cappedImportCount = deduped.length - compacted.length;
  const suppressedCount = duplicateCount + cappedImportCount;

  return {
    diagnostics: compacted,
    duplicateCount,
    cappedImportCount,
    suppressedCount,
  };
};

const pluralize = (count: number, singular: string, plural: string): string =>
  count === 1 ? singular : plural;

export const formatCompactionSummary = (
  result: DiagnosticsCompactionResult,
): string | undefined => {
  if (result.suppressedCount <= 0) {
    return undefined;
  }

  const duplicateLabel = pluralize(
    result.duplicateCount,
    "duplicate",
    "duplicates",
  );
  const cappedImportLabel = pluralize(
    result.cappedImportCount,
    "import diagnostic above display limit",
    "import diagnostics above display limit",
  );

  return [
    `Suppressed ${result.suppressedCount} additional diagnostics`,
    `(${result.duplicateCount} ${duplicateLabel}, ${result.cappedImportCount} ${cappedImportLabel}).`,
  ].join(" ");
};
