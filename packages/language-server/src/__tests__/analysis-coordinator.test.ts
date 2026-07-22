import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { FileChangeType } from "vscode-languageserver/lib/node/main.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import { definitionsAtPosition } from "../project.js";
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

const withStdRoot = async <T>(
  rootDir: string,
  callback: () => Promise<T>,
): Promise<T> => {
  const previousStdRoot = process.env.VOYD_STD_ROOT;

  try {
    process.env.VOYD_STD_ROOT = rootDir;
    return await callback();
  } finally {
    if (previousStdRoot === undefined) {
      delete process.env.VOYD_STD_ROOT;
    } else {
      process.env.VOYD_STD_ROOT = previousStdRoot;
    }
  }
};

describe("analysis coordinator", () => {
  it("publishes diagnostics for standalone test files", async () => {
    const project = await createProject({
      "src/main.voyd": `fn main() -> i32\n  1\n`,
      "src/math.test.voyd": `fn broken() -> i32\n  missing_symbol\n`,
    });
    const std = await createProject({
      "pkg.voyd": "",
    });

    try {
      await withStdRoot(std.rootDir, async () => {
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
      });
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
      await rm(std.rootDir, { recursive: true, force: true });
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

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const entryUri = toFileUri(entryPath);
      const source = `use std::math::forty_two\n\nfn main() -> i32\n  forty_two()\n`;
      const coordinator = new AnalysisCoordinator();
      const document = TextDocument.create(entryUri, "voyd", 1, source);

      const { analysis: missingStdAnalysis } = await withStdRoot(missingStd.rootDir, async () => {
        coordinator.updateDocument(document);
        return await coordinator.getCoreForUri(entryUri);
      });
      const missingStdDiagnostics = missingStdAnalysis.diagnosticsByUri.get(entryUri) ?? [];

      const { analysis: completeStdAnalysis } = await withStdRoot(
        completeStd.rootDir,
        async () => await coordinator.getCoreForUri(entryUri),
      );
      const completeStdDiagnostics = completeStdAnalysis.diagnosticsByUri.get(entryUri) ?? [];

      expect(missingStdDiagnostics.length).toBeGreaterThan(0);
      expect(completeStdDiagnostics).toHaveLength(0);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
      await rm(missingStd.rootDir, { recursive: true, force: true });
      await rm(completeStd.rootDir, { recursive: true, force: true });
    }
  });

  it("discovers imported modules created after the initial analysis", async () => {
    const project = await createProject({
      "src/main.voyd":
        `use src::generated::value\n\nfn main() -> i32\n  value()\n`,
    });
    const std = await createProject({
      "pkg.voyd": "",
    });

    try {
      await withStdRoot(std.rootDir, async () => {
        const mainPath = project.filePathFor("src/main.voyd");
        const mainUri = toFileUri(mainPath);
        const generatedPath = project.filePathFor("src/generated.voyd");
        const generatedUri = toFileUri(generatedPath);
        const coordinator = new AnalysisCoordinator();

        const initial = await coordinator.getCoreForUri(mainUri);
        const initialDiagnostics = initial.analysis.diagnosticsByUri.get(mainUri) ?? [];
        expect(initialDiagnostics.some(({ code }) => code === "BD0001")).toBe(true);

        await writeFile(generatedPath, `pub fn value() -> i32\n  42\n`, "utf8");
        await coordinator.handleWatchedFileChanges([
          { uri: generatedUri, type: FileChangeType.Created },
        ]);

        const updated = await coordinator.getCoreForUri(mainUri);
        expect(updated.analysis.diagnosticsByUri.get(mainUri) ?? []).toHaveLength(0);
      });
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
      await rm(std.rootDir, { recursive: true, force: true });
    }
  });

  it("reloads package directory configuration when package.json changes", async () => {
    const project = await createProject({
      "src/main.voyd":
        `use pkg::my_pkg::all\n\nfn main() -> i32\n  value()\n`,
      "voyd-packages/my_pkg/src/pkg.voyd":
        `pub fn value() -> i32\n  42\n`,
    });
    const std = await createProject({
      "pkg.voyd": "",
    });

    try {
      await withStdRoot(std.rootDir, async () => {
        const mainPath = project.filePathFor("src/main.voyd");
        const mainUri = toFileUri(mainPath);
        const manifestPath = project.filePathFor("package.json");
        const coordinator = new AnalysisCoordinator();

        const initial = await coordinator.getCoreForUri(mainUri);
        expect(initial.analysis.graph.modules.has("pkg:my_pkg::pkg")).toBe(false);

        const unrelatedManifestPath = project.filePathFor(
          "unrelated/package.json",
        );
        await mkdir(path.dirname(unrelatedManifestPath), { recursive: true });
        await writeFile(unrelatedManifestPath, "{}", "utf8");
        const unrelatedChanged = await coordinator.handleWatchedFileChanges([
          {
            uri: toFileUri(unrelatedManifestPath),
            type: FileChangeType.Created,
          },
        ]);
        expect(unrelatedChanged).toBe(false);

        await writeFile(
          manifestPath,
          JSON.stringify({
            voyd: { packageDirectories: ["./voyd-packages"] },
          }),
          "utf8",
        );
        const changed = await coordinator.handleWatchedFileChanges([
          { uri: toFileUri(manifestPath), type: FileChangeType.Created },
        ]);

        expect(changed).toBe(true);
        const updated = await coordinator.getCoreForUri(mainUri);
        expect(updated.analysis.graph.modules.has("pkg:my_pkg::pkg")).toBe(true);
        expect(updated.analysis.diagnosticsByUri.get(mainUri) ?? []).toHaveLength(0);
      });
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
      await rm(std.rootDir, { recursive: true, force: true });
    }
  });

  it("reports invalid package configuration without rejecting analysis", async () => {
    const project = await createProject({
      "package.json": JSON.stringify({
        voyd: { packageDirectories: "./voyd-packages" },
      }),
      "src/main.voyd": `fn main() -> i32\n  42\n`,
    });
    const std = await createProject({
      "pkg.voyd": "",
    });

    try {
      await withStdRoot(std.rootDir, async () => {
        const mainUri = toFileUri(project.filePathFor("src/main.voyd"));
        const coordinator = new AnalysisCoordinator();

        const { analysis } = await coordinator.getCoreForUri(mainUri);
        expect(analysis.diagnosticsByUri.get(mainUri)).toEqual([
          expect.objectContaining({
            code: "VOYD_CONFIG",
            message: expect.stringMatching(/voyd\.packageDirectories/),
          }),
        ]);
      });
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
      await rm(std.rootDir, { recursive: true, force: true });
    }
  });

  it("keeps package semantics valid after opening an imported definition", async () => {
    const mainSource =
      `use pkg::demo::all\n\nfn passthrough<Model, Msg>(value: Tessera<Model, Msg>) -> Tessera<Model, Msg>\n  value\n`;
    const apiSource =
      `use std::vx::Program\n\npub type Tessera<Model, Msg> = Program<Model, Msg>\n`;
    const project = await createProject({
      "package.json": JSON.stringify({
        voyd: { packageDirectories: ["./voyd-packages"] },
      }),
      "examples/main.voyd": mainSource,
      "voyd-packages/demo/package.json": JSON.stringify({
        name: "demo",
        version: "0.0.0",
      }),
      "voyd-packages/demo/src/pkg.voyd":
        `pub src::api\npub use src::api::{ Tessera }\n`,
      "voyd-packages/demo/src/api.voyd": apiSource,
    });

    try {
      const mainPath = project.filePathFor("examples/main.voyd");
      const mainUri = toFileUri(mainPath);
      const apiPath = project.filePathFor("voyd-packages/demo/src/api.voyd");
      const apiUri = toFileUri(apiPath);
      const coordinator = new AnalysisCoordinator();
      coordinator.updateDocument(
        TextDocument.create(mainUri, "voyd", 1, mainSource),
      );

      const initial = await coordinator.getCoreForUri(mainUri);
      expect(initial.analysis.diagnosticsByUri.get(mainUri) ?? []).toHaveLength(0);

      const initialNavigation = await coordinator.getNavigationForUri(mainUri);
      expect(
        definitionsAtPosition({
          analysis: initialNavigation,
          uri: mainUri,
          position: { line: 2, character: 36 },
        }),
      ).toEqual([
        expect.objectContaining({ uri: apiUri }),
      ]);

      coordinator.updateDocument(
        TextDocument.create(apiUri, "voyd", 1, apiSource),
      );

      const updated = await coordinator.getCoreForUri(mainUri);
      expect(updated.analysis.diagnosticsByUri.get(mainUri) ?? []).toHaveLength(0);
      expect(updated.analysis.diagnosticsByUri.get(apiUri) ?? []).toHaveLength(0);
      expect(updated.analysis.graph.modules.has("pkg:demo::pkg")).toBe(true);

      const updatedNavigation = await coordinator.getNavigationForUri(mainUri);
      expect(
        definitionsAtPosition({
          analysis: updatedNavigation,
          uri: mainUri,
          position: { line: 2, character: 36 },
        }),
      ).toEqual([
        expect.objectContaining({ uri: apiUri }),
      ]);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("reuses unaffected module semantics after an edit", async () => {
    const project = await createProject({
      "src/main.voyd":
        `use src::util::value\nuse src::helper::helper\n\nfn main() -> i32\n  value() + helper()\n`,
      "src/util.voyd": `pub fn value() -> i32\n  1\n`,
      "src/helper.voyd": `pub fn helper() -> i32\n  2\n`,
    });

    try {
      const mainUri = toFileUri(project.filePathFor("src/main.voyd"));
      const utilUri = toFileUri(project.filePathFor("src/util.voyd"));
      const coordinator = new AnalysisCoordinator();
      coordinator.updateDocument(
        TextDocument.create(
          utilUri,
          "voyd",
          1,
          `pub fn value() -> i32\n  1\n`,
        ),
      );

      const initial = await coordinator.getCoreForUri(mainUri);
      const initialMainSemantics = initial.analysis.semantics.get("src::main");
      const initialUtilSemantics = initial.analysis.semantics.get("src::util");
      const initialHelperSemantics = initial.analysis.semantics.get("src::helper");

      expect(initialMainSemantics).toBeDefined();
      expect(initialUtilSemantics).toBeDefined();
      expect(initialHelperSemantics).toBeDefined();
      if (!initialMainSemantics || !initialUtilSemantics || !initialHelperSemantics) {
        return;
      }

      coordinator.updateDocument(
        TextDocument.create(
          utilUri,
          "voyd",
          2,
          `pub fn value() -> i32\n  10\n`,
        ),
      );

      const updated = await coordinator.getCoreForUri(mainUri);

      expect(updated.analysis.semantics.get("src::main")).not.toBe(initialMainSemantics);
      expect(updated.analysis.semantics.get("src::util")).not.toBe(initialUtilSemantics);
      expect(updated.analysis.semantics.get("src::helper")).toBe(initialHelperSemantics);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("refreshes incremental typing state after a bounded number of edits", async () => {
    const project = await createProject({
      "src/main.voyd": `use src::helper::helper\n\nfn main() -> i32\n  helper()\n`,
      "src/helper.voyd": `pub fn helper() -> i32\n  1\n`,
    });

    try {
      const mainUri = toFileUri(project.filePathFor("src/main.voyd"));
      const coordinator = new AnalysisCoordinator({
        maxIncrementalAnalysisRuns: 1,
      });
      coordinator.updateDocument(
        TextDocument.create(
          mainUri,
          "voyd",
          1,
          `use src::helper::helper\n\nfn main() -> i32\n  helper()\n`,
        ),
      );

      const initial = await coordinator.getCoreForUri(mainUri);
      const initialHelper = initial.analysis.semantics.get("src::helper");
      expect(initialHelper).toBeDefined();

      coordinator.updateDocument(
        TextDocument.create(
          mainUri,
          "voyd",
          2,
          `use src::helper::helper\n\nfn main() -> i32\n  helper() + 1\n`,
        ),
      );
      const incremental = await coordinator.getCoreForUri(mainUri);
      expect(incremental.analysis.semantics.get("src::helper")).toBe(
        initialHelper,
      );

      coordinator.updateDocument(
        TextDocument.create(
          mainUri,
          "voyd",
          3,
          `use src::helper::helper\n\nfn main() -> i32\n  helper() + 2\n`,
        ),
      );
      const refreshed = await coordinator.getCoreForUri(mainUri);
      expect(refreshed.analysis.semantics.get("src::helper")).not.toBe(
        initialHelper,
      );
      expect(refreshed.analysis.diagnosticsByUri.get(mainUri) ?? []).toHaveLength(0);
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("preempts stale core runs during rapid edits", async () => {
    const moduleCount = 220;
    const project = await createProject({
      ...Object.fromEntries(
        Array.from({ length: moduleCount }, (_entry, index) => [
          `src/mod_${index}.voyd`,
          `pub fn value_${index}() -> i32\n  ${index}\n`,
        ]),
      ),
      "src/core.voyd":
        `${Array.from({ length: moduleCount }, (_entry, index) => `use src::mod_${index}::value_${index}`).join("\n")}\n\npub fn total() -> i32\n  ${Array.from({ length: moduleCount }, (_entry, index) => `value_${index}()`).join(" + ")}\n`,
      "src/main.voyd": `use src::core::total\n\nfn main() -> i32\n  total()\n`,
    });
    const std = await createProject({
      "pkg.voyd": "",
    });

    try {
      await withStdRoot(std.rootDir, async () => {
        const mainUri = toFileUri(project.filePathFor("src/main.voyd"));
        const mod0Path = project.filePathFor("src/mod_0.voyd");
        const mod0Uri = toFileUri(mod0Path);
        const coordinator = new AnalysisCoordinator();

        const firstRun = coordinator.getCoreForUri(mainUri);
        coordinator.updateDocument(
          TextDocument.create(
            mod0Uri,
            "voyd",
            2,
            `pub fn value_0() -> i32\n  9999\n`,
          ),
        );
        const secondRun = coordinator.getCoreForUri(mainUri);

        const [firstResult, secondResult] = await Promise.all([firstRun, secondRun]);
        const expectedUpdatedSource = `pub fn value_0() -> i32\n  9999\n`;
        expect(firstResult.analysis.sourceByFile.get(mod0Path)).toBe(expectedUpdatedSource);
        expect(secondResult.analysis.sourceByFile.get(mod0Path)).toBe(expectedUpdatedSource);
      });
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
      await rm(std.rootDir, { recursive: true, force: true });
    }
  }, 25_000);
});
