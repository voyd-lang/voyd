import { expect, it } from "vitest";
import {
  replaceStdSourceVersion,
  resolvePrecompiledStdVersioningAction,
} from "./runner.mjs";

it("updates the std source identity during release versioning", () => {
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

it("regenerates only for std releases and verifies compatible compiler releases", () => {
  expect(resolvePrecompiledStdVersioningAction(["@voyd-lang/compiler"])).toBe(
    "check:std-snapshot",
  );
  expect(resolvePrecompiledStdVersioningAction(["@voyd-lang/std"])).toBe(
    "generate:std-snapshot",
  );
  expect(
    resolvePrecompiledStdVersioningAction([
      "@voyd-lang/compiler",
      "@voyd-lang/std",
    ]),
  ).toBe("generate:std-snapshot");
  expect(resolvePrecompiledStdVersioningAction(["@voyd-lang/sdk"])).toBe(
    undefined,
  );
});
