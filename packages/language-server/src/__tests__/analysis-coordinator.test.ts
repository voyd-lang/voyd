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
  });
});
