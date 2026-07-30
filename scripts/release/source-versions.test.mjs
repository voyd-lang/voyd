import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { repoRoot } from "./manifest.mjs";
import {
  publishNpmTargets,
  replaceCompilerSourceVersion,
  replaceStdSourceVersion,
  validatePrecompiledStdReleaseTargets,
} from "./runner.mjs";

it("keeps the compiler snapshot identity synchronized with the package version", () => {
  const packageVersion = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "packages/compiler/package.json"),
      "utf8",
    ),
  ).version;
  const versionSource = fs.readFileSync(
    path.join(repoRoot, "packages/compiler/src/version.ts"),
    "utf8",
  );

  expect(versionSource).toContain(
    `export const VOYD_COMPILER_VERSION = "${packageVersion}" as const;`,
  );
});

it("updates compiler and std source identities during release versioning", () => {
  expect(
    replaceCompilerSourceVersion({
      source: 'export const VOYD_COMPILER_VERSION = "0.3.1" as const;\n',
      version: "0.4.0",
    }),
  ).toBe('export const VOYD_COMPILER_VERSION = "0.4.0" as const;\n');
  expect(
    replaceStdSourceVersion({
      source:
        'pub fn std_version() -> String\n  "0.3.1"\n\npub fn language_version() -> String\n  "0.3.1"\n',
      version: "0.4.0",
    }),
  ).toBe(
    'pub fn std_version() -> String\n  "0.4.0"\n\npub fn language_version() -> String\n  "0.4.0"\n',
  );
});

it("requires std to ship a newly versioned compiler snapshot", () => {
  expect(() =>
    validatePrecompiledStdReleaseTargets(["@voyd-lang/compiler"]),
  ).toThrow(/requires co-releasing @voyd-lang\/std/);
  expect(() =>
    validatePrecompiledStdReleaseTargets([
      "@voyd-lang/compiler",
      "@voyd-lang/std",
    ]),
  ).not.toThrow();
  expect(() =>
    validatePrecompiledStdReleaseTargets(["@voyd-lang/std"]),
  ).not.toThrow();
});

it("rejects direct compiler publication without the std artifact owner", () => {
  expect(() =>
    publishNpmTargets({
      targetNames: ["@voyd-lang/compiler"],
      dryRun: true,
      tag: "latest",
    }),
  ).toThrow(/requires co-releasing @voyd-lang\/std/);
});

it("rejects a raw compiler workspace publish in prepublishOnly", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts/release/enforce-workspace-release.mjs")],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_package_name: "@voyd-lang/compiler",
      },
    },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(
    "requires co-releasing @voyd-lang/std because std owns",
  );
});
