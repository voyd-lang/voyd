import {
  createDiagnostic,
  normalizeSpan,
  type Diagnostic,
} from "../diagnostics/index.js";

export const codegenErrorToDiagnostic = (
  error: unknown,
  options: { moduleId?: string } = {}
): Diagnostic =>
  createDiagnostic({
    code: "CG0001",
    message: error instanceof Error ? error.message : String(error),
    span: normalizeSpan(
      options.moduleId ? { file: options.moduleId, start: 0, end: 0 } : undefined,
      { file: "<codegen>", start: 0, end: 0 }
    ),
  });
