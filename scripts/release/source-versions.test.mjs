import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { repoRoot } from "./manifest.mjs";
import {
  replaceCompilerSourceVersion,
  replaceStdSourceVersion,
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
