import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";

describe("diagnostic spans", () => {
  it("preserves string literal spans through parsing and typing", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), `voyd-span-${Date.now()}-`));
    try {
      const entryPath = join(projectRoot, "main.voyd");
      writeFileSync(
        entryPath,
        `use std::all

pub fn takes(value: i32) -> void
  void

pub fn main() -> void
  takes(\"Hi\")
  void
`,
        "utf8",
      );

      const stdRoot = resolve(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "std",
        "src",
      );
      const graph = await loadModuleGraph({
        entryPath,
        roots: { src: projectRoot, std: stdRoot },
      });

      const { diagnostics } = analyzeModules({ graph });
      expect(diagnostics.some((diag) => diag.severity === "error")).toBe(true);
      const diagnostic = diagnostics.find((diag) => diag.severity === "error");
      expect(diagnostic).toBeDefined();
      if (!diagnostic) {
        return;
      }

      expect(diagnostic.code).toBe("TY0027");
      expect(diagnostic.span.file).toBe(entryPath);
      const source = readFileSync(entryPath, "utf8");
      expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toBe(
        "\"Hi\"",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
