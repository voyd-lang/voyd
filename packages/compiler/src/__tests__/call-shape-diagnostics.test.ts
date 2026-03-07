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

const expectCompileSuccess = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: true }> => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("expected compile success");
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

  it("accepts out-of-order labeled arguments when every parameter is labeled", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `
obj Camera {
  image_width: i32,
  center: i32
}

pub fn main() -> i32
  let camera = Camera { center: 3, image_width: 7 }
  camera.image_width + camera.center
`,
    });

    expectCompileSuccess(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );
  });

  it("reports the full count of duplicate labeled arguments", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `
obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

fn foo({ x?: i32 }) -> i32
  1

pub fn main() -> i32
  foo(x: 1, x: 2, x: 3)
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    const diagnostic = result.diagnostics.find((entry) => entry.code === "TY0021");
    expect(diagnostic).toBeDefined();
    if (!diagnostic) {
      return;
    }
    expect(diagnostic.message).toContain("call has 2 extra argument(s)");
  });

  it("reports label mismatch for unexpected labels in all-labeled calls", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `
obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

fn foo({ x: i32 }) -> i32
  x

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

    const diagnostic = result.diagnostics.find((entry) => entry.code === "TY0021");
    expect(diagnostic).toBeDefined();
    if (!diagnostic) {
      return;
    }
    expect(diagnostic.message).toContain(
      "call argument 1 label mismatch: expected x, got z",
    );
  });

  it("reports the failing argument index for all-labeled label mismatches", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `
obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

fn foo({ a: i32, b: i32 }) -> i32
  a + b

pub fn main() -> i32
  foo(c: 1, z: 2)
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    const diagnostic = result.diagnostics.find((entry) => entry.code === "TY0021");
    expect(diagnostic).toBeDefined();
    if (!diagnostic) {
      return;
    }
    expect(diagnostic.message).toContain(
      "call argument 1 label mismatch: expected a, got c",
    );
  });

  it("prefers the truly unexpected label when required labeled parameters are missing", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `
obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

fn foo({ a: i32, b: i32 }) -> i32
  a + b

pub fn main() -> i32
  foo(b: 1, z: 2)
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    const diagnostic = result.diagnostics.find((entry) => entry.code === "TY0021");
    expect(diagnostic).toBeDefined();
    if (!diagnostic) {
      return;
    }
    expect(diagnostic.message).toContain(
      "call argument 2 label mismatch: expected a, got z",
    );
  });
});
