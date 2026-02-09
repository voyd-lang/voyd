import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  analyzeProject,
  autoImportActions,
  definitionsAtPosition,
  renameAtPosition,
  resolveModuleRoots,
  toFileUri,
} from "../project.js";

const createProject = async (
  files: Record<string, string>,
): Promise<{ rootDir: string; filePathFor: (relativePath: string) => string }> => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "voyd-ls-test-"));

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

describe("language server project analysis", () => {
  it("resolves go-to-definition for imported functions", async () => {
    const project = await createProject({
      "src/main.voyd": `use src::util::helper\n\nfn main() -> i32\n  helper(1)\n`,
      "src/util.voyd": `pub fn helper(value: i32) -> i32\n  value\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const definitions = definitionsAtPosition({
        analysis,
        uri: toFileUri(entryPath),
        position: { line: 3, character: 3 },
      });

      expect(definitions).toHaveLength(1);
      expect(definitions[0]?.uri).toBe(toFileUri(project.filePathFor("src/util.voyd")));
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("renames local variables and references", async () => {
    const project = await createProject({
      "src/main.voyd": `fn main() -> i32\n  let counter = 1\n  counter\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const edit = renameAtPosition({
        analysis,
        uri: toFileUri(entryPath),
        position: { line: 2, character: 3 },
        newName: "total",
      });

      const changes = edit?.changes?.[toFileUri(entryPath)] ?? [];
      expect(changes.length).toBeGreaterThanOrEqual(2);
      expect(changes.every((change: { newText: string }) => change.newText === "total")).toBe(
        true,
      );
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("renames imported symbols in use statements and call sites", async () => {
    const project = await createProject({
      "src/main.voyd": `use src::util::helper\n\nfn main() -> i32\n  helper(1)\n`,
      "src/util.voyd": `pub fn helper(value: i32) -> i32\n  value\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const utilPath = project.filePathFor("src/util.voyd");
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const edit = renameAtPosition({
        analysis,
        uri: toFileUri(entryPath),
        position: { line: 3, character: 3 },
        newName: "assist",
      });

      const mainChanges = edit?.changes?.[toFileUri(entryPath)] ?? [];
      const utilChanges = edit?.changes?.[toFileUri(utilPath)] ?? [];
      expect(mainChanges.some((change) => change.range.start.line === 0)).toBe(true);
      expect(mainChanges.some((change) => change.range.start.line === 3)).toBe(true);
      expect(utilChanges.some((change) => change.range.start.line === 0)).toBe(true);
      expect(
        [...mainChanges, ...utilChanges].every(
          (change: { newText: string }) => change.newText === "assist",
        ),
      ).toBe(true);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("offers auto-import quick fixes for unknown functions", async () => {
    const project = await createProject({
      "src/main.voyd": `fn main() -> i32\n  helper(1)\n`,
      "src/util.voyd": `pub fn helper(value: i32) -> i32\n  value\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const uri = toFileUri(entryPath);
      const analysis = await analyzeProject({
        entryPath,
        roots: resolveModuleRoots(entryPath),
        openDocuments: new Map(),
      });

      const diagnostics = analysis.diagnosticsByUri.get(uri) ?? [];
      const codeActions = autoImportActions({
        analysis,
        documentUri: uri,
        diagnostics,
      });

      expect(
        codeActions.some((action) =>
          action.title.includes("Import helper from src::util"),
        ),
      ).toBe(true);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });
});
