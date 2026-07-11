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
  it("reports malformed declaration shapes before binding", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({ [entryPath]: "pub fn main()" });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("MD0002");
    expect(result.diagnostics[0]?.message).toBe("fn missing body expression");
  });

  it("reports malformed record types as surface syntax diagnostics", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({ [entryPath]: "pub type Foo = { bar }" });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("MD0002");
    expect(result.diagnostics[0]?.message).toBe(
      "object type fields must be labeled",
    );
    expect(result.diagnostics[0]?.span.start).toBeGreaterThan(0);
  });

  it("reports function types without return types as surface syntax", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: "pub type Callback = fn(i32)",
    });

    const result = expectCompileFailure(
      await compileProgram({ entryPath, roots: { src: root }, host }),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("MD0002");
    expect(result.diagnostics[0]?.message).toBe(
      "function type missing return type",
    );
  });

  it("reports malformed labeled call arguments as surface syntax", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `fn use({ value: i32 }) -> i32
  value

pub fn main() -> i32
  use(1: 2)`,
    });

    const result = expectCompileFailure(
      await compileProgram({ entryPath, roots: { src: root }, host }),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("MD0002");
    expect(result.diagnostics[0]?.message).toBe(
      "labeled call argument requires an identifier label and one value",
    );
  });

  it("reports a missing comma between object literal fields", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `pub fn main() -> i32
  let value = { first: 1 second: 2 }
  value.first`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("MD0002");
    expect(result.diagnostics[0]?.message).toContain(
      "Expected ',' before 'second' in braces",
    );
  });

  it("rejects optional markers on runtime object fields at the surface", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `pub fn main() -> i32
  let value = { count?: 1 }
  value.count`,
    });

    const result = expectCompileFailure(
      await compileProgram({ entryPath, roots: { src: root }, host }),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("MD0002");
    expect(result.diagnostics[0]?.message).toBe(
      "unsupported object literal entry",
    );
  });

  it("reports malformed effect handler parameters as surface syntax", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `eff Async
  fn await(value: i32) -> i32

pub fn main(): Async -> i32
  try
    Async::await(1)
  Async::await(1 + 2):
    0`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("MD0002");
    expect(result.diagnostics[0]?.message).toBe(
      "handler parameter must be an identifier or typed identifier",
    );
    expect(result.diagnostics[0]?.span.start).toBeGreaterThan(0);
  });

  it("reports malformed embedded effect handlers as surface syntax", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `eff Async
  fn await(value: i32) -> i32

pub fn main(): Async -> i32
  try
    Async::await(1)
    Async::await(1 + 2):
      0`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("MD0002");
    expect(result.diagnostics[0]?.message).toBe(
      "handler parameter must be an identifier or typed identifier",
    );
  });

  it("reports malformed match binding patterns as surface syntax", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `obj Dog { noses: i32 }

pub fn main() -> i32
  let dog = Dog { noses: 1 }
  match(dog)
    Dog as 1: 0`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe("MD0002");
    expect(result.diagnostics[0]?.message).toBe("unsupported pattern form");
  });

  it("allows labeled calls as object literal field values", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `fn make({ value: i32 }) -> i32
  value

pub fn main() -> i32
  let result = { value: make(value: 2) }
  result.value`,
    });

    expectCompileSuccess(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );
  });

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

    expect(result.diagnostics.some((entry) => entry.code === "TY9999")).toBe(
      false,
    );
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "TY0021",
    );
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

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "TY0021",
    );
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

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "TY0021",
    );
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

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "TY0021",
    );
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

    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "TY0021",
    );
    expect(diagnostic).toBeDefined();
    if (!diagnostic) {
      return;
    }
    expect(diagnostic.message).toContain(
      "call argument 2 label mismatch: expected a, got z",
    );
  });
});
