import {
  diagnosticFromCode,
  normalizeSpan,
  type Diagnostic,
} from "../diagnostics/index.js";
import { modulePathToString } from "./path.js";
import type { ModuleDiagnostic } from "./types.js";

export const moduleDiagnosticToDiagnostic = (
  diagnostic: ModuleDiagnostic
): Diagnostic => {
  const requested = modulePathToString(diagnostic.requested);
  const importer = diagnostic.importerFilePath ?? diagnostic.importer;
  const importerSpan = diagnostic.importerFilePath
    ? { file: diagnostic.importerFilePath, start: 0, end: 0 }
    : undefined;
  const span = normalizeSpan(diagnostic.span, importerSpan);

  if (diagnostic.kind === "missing-module") {
    const related =
      importer && importerSpan
        ? [
            diagnosticFromCode({
              code: "MD0001",
              params: { kind: "referenced-from", importer },
              span: importerSpan,
              severity: "note",
            }),
          ]
        : undefined;

    return diagnosticFromCode({
      code: "MD0001",
      params: { kind: "missing", requested },
      span,
      related,
    });
  }

  if (diagnostic.kind === "reserved-module-segment") {
    return diagnosticFromCode({
      code: "MD0005",
      params: {
        kind: "reserved-module-segment",
        requested,
        segment: diagnostic.segment,
      },
      span,
    });
  }

  const related =
    importer && importerSpan
      ? [
          diagnosticFromCode({
            code: "MD0002",
            params: { kind: "requested-from", importer },
            span: importerSpan,
            severity: "note",
          }),
        ]
      : undefined;

  return diagnosticFromCode({
    code: "MD0002",
    params: {
      kind: "load-failed",
      requested,
      errorMessage: diagnostic.message || undefined,
    },
    span,
    related,
  });
};
