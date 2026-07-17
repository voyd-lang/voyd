import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  inspectVoydPackageDirectories,
  resolveVoydPackageDirectories,
} from "../package-directories.js";

describe("resolveVoydPackageDirectories", () => {
  it("combines explicit, inherited package.json, and node_modules directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "voyd-package-config-"));
    const projectRoot = path.join(root, "workspace");
    const packageRoot = path.join(projectRoot, "apps", "consumer");
    const sourceRoot = path.join(packageRoot, "src");

    try {
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(
        path.join(projectRoot, "package.json"),
        JSON.stringify({
          voyd: { packageDirectories: ["./shared-packages"] },
        }),
      );
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          voyd: { packageDirectories: ["./local-packages"] },
        }),
      );

      const directories = resolveVoydPackageDirectories({
        sourceRoot,
        additionalPackageDirectories: ["../override-packages"],
      });

      expect(directories.slice(0, 3)).toEqual([
        path.join(packageRoot, "override-packages"),
        path.join(packageRoot, "local-packages"),
        path.join(projectRoot, "shared-packages"),
      ]);
      expect(directories).toContain(path.join(sourceRoot, "node_modules"));
      expect(directories).toContain(path.join(projectRoot, "node_modules"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed package directory configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "voyd-package-config-"));

    try {
      await writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ voyd: { packageDirectories: "./packages" } }),
      );

      expect(() =>
        resolveVoydPackageDirectories({ sourceRoot: root }),
      ).toThrow(/voyd\.packageDirectories.*array of non-empty strings/);

      const inspection = inspectVoydPackageDirectories({ sourceRoot: root });
      expect(inspection.packageDirectories).toContain(
        path.join(root, "node_modules"),
      );
      expect(inspection.issues).toEqual([
        expect.objectContaining({
          manifestPath: path.join(root, "package.json"),
          message: expect.stringMatching(/voyd\.packageDirectories/),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
