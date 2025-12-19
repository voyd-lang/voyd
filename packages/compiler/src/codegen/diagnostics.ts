import {
  diagnosticFromCode,
  normalizeSpan,
  type Diagnostic,
} from "../diagnostics/index.js";

export const codegenErrorToDiagnostic = (
  error: unknown,
  options: { moduleId?: string } = {}
): Diagnostic =>
  diagnosticFromCode({
    code: "CG0001",
    params: { kind: "codegen-error", message: error instanceof Error ? error.message : String(error) },
    span: normalizeSpan(
      options.moduleId ? { file: options.moduleId, start: 0, end: 0 } : undefined,
      { file: "<codegen>", start: 0, end: 0 }
    ),
  });
