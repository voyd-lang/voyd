import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { compileProgram, type CompileProgramResult } from "../pipeline.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const expectCompileFailure = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: false }> => {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("expected compile failure");
  }
  return result;
};

describe("call shape diagnostics", () => {
  it("reports label mismatch argument index using the failing argument position", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `
obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

fn foo(x?: i32, { y: i32 }) -> i32
  y

fn foo(x?: bool, { y: i32 }) -> i32
  y

pub fn main() -> i32
  foo(z: 7)
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    expect(result.diagnostics.some((entry) => entry.code === "TY9999")).toBe(false);
    const diagnostic = result.diagnostics.find((entry) => entry.code === "TY0021");
    expect(diagnostic).toBeDefined();
    if (!diagnostic) {
      return;
    }

    expect(diagnostic.message).toContain(
      "call argument 1 label mismatch: expected y, got z",
    );
  });
});
