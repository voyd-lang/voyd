import path from "node:path";
import type {
  Diagnostic as CompilerDiagnostic,
  SourceSpan,
} from "@voyd/compiler/diagnostics/index.js";
import {
  Diagnostic,
  DiagnosticSeverity,
} from "vscode-languageserver/lib/node/main.js";
import { toFileUri } from "./files.js";
import { LineIndex, spanRange } from "./text.js";

const diagnosticSeverity = (severity: CompilerDiagnostic["severity"]): DiagnosticSeverity => {
  switch (severity) {
    case "error":
      return DiagnosticSeverity.Error;
    case "warning":
      return DiagnosticSeverity.Warning;
    default:
      return DiagnosticSeverity.Information;
  }
};

export const buildDiagnosticsByUri = ({
  diagnostics,
  lineIndexByFile,
}: {
  diagnostics: readonly CompilerDiagnostic[];
  lineIndexByFile: ReadonlyMap<string, LineIndex>;
}): Map<string, Diagnostic[]> => {
  const diagnosticsByUri = new Map<string, Diagnostic[]>();

  diagnostics.forEach((diagnostic) => {
    const filePath = path.resolve((diagnostic.span as SourceSpan).file);
    const lineIndex = lineIndexByFile.get(filePath);
    const range = spanRange({ span: diagnostic.span, lineIndex });
    if (!range) {
      return;
    }

    const uri = toFileUri(filePath);
    const existing = diagnosticsByUri.get(uri) ?? [];
    existing.push({
      range,
      code: diagnostic.code,
      source: "voyd",
      message: diagnostic.message,
      severity: diagnosticSeverity(diagnostic.severity),
    });
    diagnosticsByUri.set(uri, existing);
  });

  return diagnosticsByUri;
};
