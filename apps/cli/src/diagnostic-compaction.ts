import type { Diagnostic } from "@voyd/sdk/compiler";

export type DiagnosticsCompactionResult = {
  diagnostics: Diagnostic[];
  duplicateCount: number;
  cascadeCount: number;
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
  const importDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.code === IMPORT_DIAGNOSTIC_CODE,
  );

  if (importDiagnostics.length <= MAX_BD0001_DIAGNOSTICS) {
    return [...diagnostics];
  }

  const firstImportByFile = new Map<string, Diagnostic>();
  importDiagnostics.forEach((diagnostic) => {
    if (!firstImportByFile.has(diagnostic.span.file)) {
      firstImportByFile.set(diagnostic.span.file, diagnostic);
    }
  });

  const keptImportKeys = new Set(
    Array.from(firstImportByFile.values())
      .slice(0, MAX_BD0001_DIAGNOSTICS)
      .map((diagnostic) => diagnosticKey(diagnostic)),
  );

  return diagnostics.filter((diagnostic) =>
    diagnostic.code !== IMPORT_DIAGNOSTIC_CODE
      ? true
      : keptImportKeys.has(diagnosticKey(diagnostic)),
  );
};

export const compactDiagnosticsForCli = (
  diagnostics: readonly Diagnostic[],
): DiagnosticsCompactionResult => {
  const deduped = dedupeDiagnostics(diagnostics);
  const compacted = compactImportDiagnostics(deduped);

  const duplicateCount = diagnostics.length - deduped.length;
  const cascadeCount = deduped.length - compacted.length;
  const suppressedCount = duplicateCount + cascadeCount;

  return {
    diagnostics: compacted,
    duplicateCount,
    cascadeCount,
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
  const cascadeLabel = pluralize(
    result.cascadeCount,
    "cascading import diagnostic",
    "cascading import diagnostics",
  );

  return [
    `Suppressed ${result.suppressedCount} additional diagnostics`,
    `(${result.duplicateCount} ${duplicateLabel}, ${result.cascadeCount} ${cascadeLabel}).`,
  ].join(" ");
};
