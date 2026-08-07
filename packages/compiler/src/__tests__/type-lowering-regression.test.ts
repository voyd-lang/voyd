import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";
import { wasmTypeFor } from "../codegen/types.js";
import { createTestCodegenContext } from "../codegen/__tests__/support/test-codegen-context.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { compileProgram, type CompileProgramResult } from "../pipeline.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const expectCompileSuccess = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: true }> => {
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("type lowering regression", () => {
  it("keeps signature lowering free of RTT side effects", () => {
    const { ctx, descriptors } = createTestCodegenContext();
    const i32Type = 1;
    const structType = 2;

    descriptors.set(i32Type, { kind: "primitive", name: "i32" });
    descriptors.set(structType, {
      kind: "structural-object",
      fields: [{ name: "value", type: i32Type, optional: false }],
    });

    const result = wasmTypeFor(structType, ctx, new Set(), "signature");
    expect(result).toBe(ctx.rtt.baseType);
    expect(ctx.structTypes.size).toBe(0);
    expect(ctx.runtimeTypeRegistry.size).toBe(0);
  });

  it("links cross-module trait impls without order hazards", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use src::traits::{ Countable }
use src::impls::{ Box }

pub fn main() -> i32
  let value = Box { value: 41 }
  value.count() + 1
`,
      [`${root}${sep}traits.voyd`]: `pub trait Countable
  fn count(self) -> i32
`,
      [`${root}${sep}impls.voyd`]: `use src::traits::{ Countable }

pub obj Box {
  value: i32,
}

impl Countable for Box
  fn count(self) -> i32
    self.value
`,
    });

    const result = expectCompileSuccess(await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    }));
    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("preserves mutable value receiver updates through optimized helper forwarding", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `pub val Counter {
  current: i32
}

impl Counter
  fn next(~self) -> i32
    self.current = self.current + 1
    self.current

fn sample(~counter: Counter) -> i32
  counter.next()

pub fn main() -> i32
  let ~counter = Counter { current: 0 }
  let first = sample(counter)
  let second = sample(counter)
  first + second + counter.current
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
        codegenOptions: { optimize: true },
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });

  it("preserves mutable value receiver updates across while-loop iterations", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `pub val Counter {
  current: i64
}

impl Counter
  fn next(~self) -> i64
    self.current = self.current + 1i64
    self.current

pub fn main() -> i32
  let ~counter = Counter { current: 0i64 }
  var index = 0
  var sum = 0i64

  while index < 3:
    sum = sum + counter.next()
    index = index + 1

  if sum == 6i64 and counter.current == 3i64 then:
    1
  else:
    0
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: `${root}${sep}main.voyd`,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(1);
  });
});
