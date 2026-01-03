import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const vtBin = resolve(projectRoot, "node_modules/.bin/vt");
const fixturePath = resolve(
  projectRoot,
  "apps/cli/src/__tests__/fixtures/sample.voyd",
);

describe("vt bin (dev)", () => {
  it("emits parser AST JSON", () => {
    const stdout = execFileSync(vtBin, ["--emit-parser-ast", fixturePath], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

