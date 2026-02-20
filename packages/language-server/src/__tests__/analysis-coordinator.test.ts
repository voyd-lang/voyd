import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TextDocument } from "vscode-languageserver-textdocument";
import { toFileUri } from "../project/files.js";
import { AnalysisCoordinator } from "../server/analysis-coordinator.js";

const createProject = async (
  files: Record<string, string>,
): Promise<{ rootDir: string; filePathFor: (relativePath: string) => string }> => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "voyd-ls-coordinator-test-"));

  await Promise.all(
    Object.entries(files).map(async ([relativePath, contents]) => {
      const fullPath = path.join(rootDir, relativePath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, contents, "utf8");
    }),
  );

  return {
    rootDir,
    filePathFor: (relativePath: string) => path.join(rootDir, relativePath),
  };
};

describe("analysis coordinator", () => {
  it("publishes diagnostics for standalone test files", async () => {
    const project = await createProject({
      "src/main.voyd": `fn main() -> i32\n  1\n`,
      "src/math.test.voyd": `fn broken() -> i32\n  missing_symbol\n`,
    });

    try {
      const testPath = project.filePathFor("src/math.test.voyd");
      const testUri = toFileUri(testPath);
      const coordinator = new AnalysisCoordinator();
      const document = TextDocument.create(
        testUri,
        "voyd",
        1,
        `fn broken() -> i32\n  missing_symbol\n`,
      );

      coordinator.updateDocument(document);

      const { analysis } = await coordinator.getCoreForUri(testUri);
      const diagnostics = analysis.diagnosticsByUri.get(testUri) ?? [];

      expect(diagnostics.length).toBeGreaterThan(0);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("recomputes analysis when module roots change for the same entry", async () => {
    const project = await createProject({
      "src/main.voyd":
        `use std::math::forty_two\n\nfn main() -> i32\n  forty_two()\n`,
    });
    const missingStd = await createProject({
      "pkg.voyd": "",
    });
    const completeStd = await createProject({
      "pkg.voyd": "",
      "math.voyd": `pub fn forty_two() -> i32\n  42\n`,
    });

    const previousStdRoot = process.env.VOYD_STD_ROOT;

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const entryUri = toFileUri(entryPath);
      const source = `use std::math::forty_two\n\nfn main() -> i32\n  forty_two()\n`;
      const coordinator = new AnalysisCoordinator();
      const document = TextDocument.create(entryUri, "voyd", 1, source);

      process.env.VOYD_STD_ROOT = missingStd.rootDir;
      coordinator.updateDocument(document);
      const { analysis: missingStdAnalysis } = await coordinator.getCoreForUri(entryUri);
      const missingStdDiagnostics = missingStdAnalysis.diagnosticsByUri.get(entryUri) ?? [];

      process.env.VOYD_STD_ROOT = completeStd.rootDir;
      const { analysis: completeStdAnalysis } = await coordinator.getCoreForUri(entryUri);
      const completeStdDiagnostics = completeStdAnalysis.diagnosticsByUri.get(entryUri) ?? [];

      expect(missingStdDiagnostics.length).toBeGreaterThan(0);
      expect(completeStdDiagnostics).toHaveLength(0);
    } finally {
      if (previousStdRoot === undefined) {
        delete process.env.VOYD_STD_ROOT;
      } else {
        process.env.VOYD_STD_ROOT = previousStdRoot;
      }
      await rm(project.rootDir, { recursive: true, force: true });
      await rm(missingStd.rootDir, { recursive: true, force: true });
      await rm(completeStd.rootDir, { recursive: true, force: true });
    }
  });
});
