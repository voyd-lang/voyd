import {
  createDiagnostic,
  normalizeSpan,
  type Diagnostic,
} from "../diagnostics/index.js";
import { modulePathToString } from "./path.js";
import type { ModuleDiagnostic } from "./types.js";

export const moduleDiagnosticToDiagnostic = (
  diagnostic: ModuleDiagnostic
): Diagnostic => {
  const requested = modulePathToString(diagnostic.requested);
  const importerSpan = diagnostic.importer
    ? { file: diagnostic.importer, start: 0, end: 0 }
    : undefined;
  const span = normalizeSpan(diagnostic.span, importerSpan);

  if (diagnostic.kind === "missing-module") {
    return createDiagnostic({
      code: "MD0001",
      message: `Unable to resolve module ${requested}`,
      span,
      related: importerSpan
        ? [
            createDiagnostic({
              code: "MD0001",
              message: `Referenced from ${diagnostic.importer}`,
              span: importerSpan,
              severity: "note",
            }),
          ]
        : undefined,
    });
  }

  return createDiagnostic({
    code: "MD0002",
    message: diagnostic.message || `Unable to load module ${requested}`,
    span,
    related: importerSpan
      ? [
          createDiagnostic({
            code: "MD0002",
            message: `Requested by ${diagnostic.importer}`,
            span: importerSpan,
            severity: "note",
          }),
        ]
      : undefined,
  });
};
