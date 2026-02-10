import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { IncrementalExportIndex, mergeExportIndexes } from "../project/exports-index.js";
import { resolveModuleRoots } from "../project/files.js";

const createProject = async (
  files: Record<string, string>,
): Promise<{ rootDir: string; filePathFor: (relativePath: string) => string }> => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "voyd-ls-export-index-"));

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

describe("incremental export index", () => {
  it("indexes workspace exports and updates changed files incrementally", async () => {
    const project = await createProject({
      "src/main.voyd": `fn main() -> i32\n  helper(1)\n`,
      "src/util.voyd": `pub fn helper(value: i32) -> i32\n  value\n`,
    });

    try {
      const entryPath = project.filePathFor("src/main.voyd");
      const utilPath = project.filePathFor("src/util.voyd");
      const roots = resolveModuleRoots(entryPath);
      const index = new IncrementalExportIndex();

      await index.ensureInitialized({
        roots,
        openDocuments: new Map(),
      });

      expect(index.exportsForRoots(roots).get("helper")?.length).toBeGreaterThan(0);

      index.updateOpenDocument({
        filePath: utilPath,
        source: `pub fn assist(value: i32) -> i32\n  value\n`,
      });

      expect(index.exportsForRoots(roots).get("helper")).toBeUndefined();
      expect(index.exportsForRoots(roots).get("assist")?.length).toBeGreaterThan(0);

      await writeFile(utilPath, `pub fn disk_only(value: i32) -> i32\n  value\n`, "utf8");
      await index.refreshFromDisk(utilPath);
      expect(index.exportsForRoots(roots).get("assist")).toBeUndefined();
      expect(index.exportsForRoots(roots).get("disk_only")?.length).toBeGreaterThan(0);

      await rm(utilPath, { force: true });
      index.deleteFile(utilPath);
      expect(index.exportsForRoots(roots).get("disk_only")).toBeUndefined();
    } finally {
      await rm(project.rootDir, { recursive: true, force: true });
    }
  });

  it("merges semantic and workspace exports without duplicates", () => {
    const merged = mergeExportIndexes({
      primary: new Map([
        [
          "helper",
          [
            {
              moduleId: "src::util",
              symbol: 1,
              name: "helper",
              kind: "value",
            },
          ],
        ],
      ]),
      secondary: new Map([
        [
          "helper",
          [
            {
              moduleId: "src::util",
              symbol: 1,
              name: "helper",
              kind: "value",
            },
            {
              moduleId: "src::other",
              symbol: -1,
              name: "helper",
              kind: "value",
            },
          ],
        ],
      ]),
    });

    const helper = merged.get("helper") ?? [];
    expect(helper).toHaveLength(2);
    expect(helper.some((entry) => entry.moduleId === "src::util")).toBe(true);
    expect(helper.some((entry) => entry.moduleId === "src::other")).toBe(true);
  });
});
