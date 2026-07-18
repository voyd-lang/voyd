import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProgram } from "../../pipeline.js";
import { createFsModuleHost } from "../../modules/fs-host.js";

const fixtureRoot = resolve(import.meta.dirname, "__fixtures__");
const stdRoot = resolve(import.meta.dirname, "../../../../std/src");

describe("shape reification", () => {
  it("compiles string metadata used by module-level shapes", async () => {
    const result = await compileProgram({
      entryPath: resolve(fixtureRoot, "shape-reification-module-let.voyd"),
      roots: { src: fixtureRoot, std: stdRoot },
      host: createFsModuleHost(),
      codegenOptions: { validate: true },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
    expect(result.wasm).toBeDefined();
  });

  it("reports unsupported types at compile time", async () => {
    const result = await compileProgram({
      entryPath: resolve(fixtureRoot, "shape-reification-unsupported.voyd"),
      roots: { src: fixtureRoot, std: stdRoot },
      host: createFsModuleHost(),
      codegenOptions: { validate: true },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected unsupported shape reification to fail");
    }
    expect(result.diagnostics[0]?.span.start).toBeGreaterThan(0);
    expect(
      result.diagnostics.find(
        (diagnostic) =>
          diagnostic.code === "CG0001" &&
          diagnostic.message.includes("shape_of<Dict") &&
          diagnostic.message.includes("boundary-compatible DTO"),
      ),
    ).toBeDefined();
  });
});
