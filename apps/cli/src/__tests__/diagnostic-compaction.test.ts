import { describe, expect, it } from "vitest";
import type { Diagnostic } from "@voyd/sdk/compiler";
import {
  compactDiagnosticsForCli,
  formatCompactionSummary,
} from "../diagnostic-compaction.js";

const makeDiagnostic = ({
  code,
  file,
  start,
  message,
}: {
  code: string;
  file: string;
  start: number;
  message: string;
}): Diagnostic => ({
  code,
  message,
  severity: "error",
  phase: code.startsWith("BD") ? "binder" : "typing",
  span: { file, start, end: start + 1 },
});

describe("diagnostic compaction", () => {
  it("deduplicates identical diagnostics", () => {
    const diagnostic = makeDiagnostic({
      code: "BD0001",
      file: "/tmp/main.voyd",
      start: 0,
      message: "Module std::pkg does not export array",
    });

    const result = compactDiagnosticsForCli([diagnostic, diagnostic, diagnostic]);

    expect(result.diagnostics).toHaveLength(1);
    expect(result.duplicateCount).toBe(2);
    expect(result.cappedImportCount).toBe(0);
    expect(result.suppressedCount).toBe(2);
  });

  it("keeps only a bounded number of cascading BD0001 diagnostics", () => {
    const diagnostics = Array.from({ length: 25 }, (_, index) =>
      makeDiagnostic({
        code: "BD0001",
        file: `/tmp/module-${index}.voyd`,
        start: index,
        message: `Module std::pkg does not export value_${index}`,
      }),
    );

    const result = compactDiagnosticsForCli(diagnostics);

    expect(result.diagnostics).toHaveLength(20);
    expect(result.duplicateCount).toBe(0);
    expect(result.cappedImportCount).toBe(5);
    expect(result.suppressedCount).toBe(5);
  });

  it("keeps multiple distinct import diagnostics from the same file when capped", () => {
    const diagnostics = Array.from({ length: 25 }, (_, index) =>
      makeDiagnostic({
        code: "BD0001",
        file: "/tmp/same-file.voyd",
        start: index,
        message: `Module std::pkg does not export value_${index}`,
      }),
    );

    const result = compactDiagnosticsForCli(diagnostics);

    expect(result.diagnostics).toHaveLength(20);
    expect(
      result.diagnostics.every(
        (diagnostic) => diagnostic.span.file === "/tmp/same-file.voyd",
      ),
    ).toBe(true);
    expect(result.cappedImportCount).toBe(5);
  });

  it("preserves non-import diagnostics while compacting cascading import diagnostics", () => {
    const rootCause = makeDiagnostic({
      code: "TY9999",
      file: "/tmp/array.voyd",
      start: 1,
      message: "static access target must be a type or module",
    });
    const importDiagnostics = Array.from({ length: 30 }, (_, index) =>
      makeDiagnostic({
        code: "BD0001",
        file: `/tmp/std-${index}.voyd`,
        start: index,
        message: `Module std::module_${index} is not available for import`,
      }),
    );

    const result = compactDiagnosticsForCli([rootCause, ...importDiagnostics]);
    const hasRootCause = result.diagnostics.some(
      (diagnostic) => diagnostic.code === "TY9999",
    );

    expect(hasRootCause).toBe(true);
    expect(
      result.diagnostics.filter((diagnostic) => diagnostic.code === "BD0001"),
    ).toHaveLength(20);
  });

  it("formats suppression summary with duplicate and cascading counts", () => {
    const summary = formatCompactionSummary({
      diagnostics: [],
      duplicateCount: 3,
      cappedImportCount: 4,
      suppressedCount: 7,
    });

    expect(summary).toBe(
      "Suppressed 7 additional diagnostics (3 duplicates, 4 import diagnostics above display limit).",
    );
  });
});
