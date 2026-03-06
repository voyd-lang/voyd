import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import {
  analyzeModules,
  compileProgram,
  loadModuleGraph,
  type CompileProgramResult,
} from "../pipeline.js";
import {
  parseEffectTable,
  runEffectfulExport,
} from "../codegen/__tests__/support/effects-harness.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const expectCompileSuccess = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: true }> => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  return result;
};

describe("pkg.voyd effect exports", () => {
  it("accepts annotated pure exports and records effect metadata", async () => {
    const root = resolve("/proj/app/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const helpersPath = `${root}${sep}utils${sep}helpers.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
use src::utils::helpers::all

pub use src::utils::helpers::pure
pub fn main(): () -> i32
  pure()
`,
      [helpersPath]: `
pub fn pure(): () -> i32
  5
`,
    });

    const graph = await loadModuleGraph({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });

    expect(diagnostics).toHaveLength(0);
    const pureExport = semantics.get("src::pkg")?.exports.get("pure");
    expect(pureExport?.effects?.[0]?.annotated).toBe(true);
    expect(pureExport?.effects?.[0]?.operations).toHaveLength(0);
  });

  it("accepts unannotated pure exports from pkg.voyd", async () => {
    const root = resolve("/proj/app/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const helpersPath = `${root}${sep}utils${sep}helpers.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
use src::utils::helpers::all

pub use src::utils::helpers::pure
pub fn main(): () -> i32
  pure()
`,
      [helpersPath]: `
pub fn pure() -> i32
  5
`,
    });

    const graph = await loadModuleGraph({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect(diagnostics).toHaveLength(0);
  });

  it("accepts unannotated effect-polymorphic exports from pkg.voyd", async () => {
    const root = resolve("/proj/app/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const helpersPath = `${root}${sep}utils${sep}helpers.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
use src::utils::helpers::all

pub use src::utils::helpers::run
pub fn main(): () -> i32
  run(() -> i32 => 1)
`,
      [helpersPath]: `
pub fn run(cb: fn() -> i32) -> i32
  cb()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect(diagnostics.some((diag) => diag.code === "TY0016")).toBe(false);
  });

  it("accepts annotations that name imported effects", async () => {
    const root = resolve("/proj/app/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const depPath = `${root}${sep}dep.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
use src::dep::{ run, Async }

pub fn draw(): Async -> i32
  run()

pub fn main(): () -> i32
  0
`,
      [depPath]: `
pub eff Async
  fn await(tail, value: i32) -> i32

pub fn run(): Async -> i32
  Async::await(1)
`,
    });

    const graph = await loadModuleGraph({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect(diagnostics.some((diag) => diag.code === "TY0014")).toBe(false);
    expect(diagnostics.some((diag) => diag.code === "TY0016")).toBe(false);
  });

  it("rejects unannotated effectful exports from pkg.voyd", async () => {
    const root = resolve("/proj/app/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const opsPath = `${root}${sep}ops.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
use src::ops::all

pub use src::ops::effectful
pub fn main(): () -> i32
  0
`,
      [opsPath]: `
eff Async
  fn await(tail) -> i32

pub fn effectful()
  Async::await()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    expect(diagnostics.some((diag) => diag.code === "TY0016")).toBe(true);

    const effectfulExport = semantics.get("src::pkg")?.exports.get("effectful");
    expect(effectfulExport?.effects?.[0]?.annotated).toBe(false);
  });

  it("rejects unannotated exports when imported generics collide with effect names", async () => {
    const root = resolve("/proj/app/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const depPath = `${root}${sep}dep.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
use src::dep::Wrap

eff Output
  fn write(tail) -> i32

fn helper(): Output -> i32
  Output::write()

pub fn draw()
  helper()
  void

pub fn main(): () -> i32
  0
`,
      [depPath]: `
pub obj Wrap<Output> {
  value: Output
}
`,
    });

    const graph = await loadModuleGraph({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    });

    const { semantics, diagnostics } = analyzeModules({ graph });
    expect(diagnostics.some((diag) => diag.code === "TY0016")).toBe(true);

    const pkg = semantics.get("src::pkg");
    expect(pkg).toBeDefined();
    if (!pkg) {
      return;
    }

    const outputSymbols = pkg.binding.symbolTable
      .resolveAll("Output", pkg.binding.symbolTable.rootScope)
      .map((symbol) => pkg.binding.symbolTable.getSymbol(symbol).kind);
    expect(outputSymbols).toEqual(["effect"]);
  });

  it("requires pub fn main to be pure", async () => {
    const root = resolve("/proj/app/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
eff Async
  fn await(tail) -> i32

pub fn main(): Async -> i32
  Async::await()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph });
    expect(diagnostics.some((diag) => diag.code === "TY0017")).toBe(true);
  });

  it("does not require effect annotations for exported generated tests", async () => {
    const root = resolve("/proj/app/src");
    const pkgPath = `${root}${sep}pkg.voyd`;
    const helpersPath = `${root}${sep}helpers.voyd`;
    const host = createMemoryHost({
      [pkgPath]: `
pub use src::helpers::all
pub fn main(): () -> i32
  0
`,
      [helpersPath]: `
eff Async
  fn await(tail) -> i32

test "effectful test":
  Async::await()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: pkgPath,
      roots: { src: root },
      host,
    });

    const { diagnostics } = analyzeModules({ graph, includeTests: true });
    expect(diagnostics.some((diag) => diag.code === "TY0016")).toBe(false);
  });

  it("codegens effectful exports with local handlers that capture locals", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), `voyd-effects-pkg-${Date.now()}-`));
    try {
      const pkgPath = join(projectRoot, "pkg.voyd");
      writeFileSync(
        pkgPath,
        `
use std::msgpack::all

eff Random
  fn next(tail) -> i32
eff Output
  fn write(tail, value: i32) -> void

pub fn draw(): Output -> void
  let seed = 7
  try forward
    let value = Random::next()
    Output::write(value)
  Random::next(tail):
    tail(seed)

pub fn main(): () -> i32
  0
`,
        "utf8",
      );

      const stdRoot = resolve(import.meta.dirname, "..", "..", "..", "std", "src");
      const result = expectCompileSuccess(
        await compileProgram({
          entryPath: pkgPath,
          roots: { src: projectRoot, std: stdRoot },
        }),
      );
      expect(result.wasm).toBeInstanceOf(Uint8Array);
      if (!result.wasm) {
        return;
      }
      const wasmBytes = new Uint8Array(result.wasm.byteLength);
      wasmBytes.set(result.wasm);

      const table = parseEffectTable(new WebAssembly.Module(wasmBytes.buffer));
      const outputWrite = table.ops.find((op) => op.label.endsWith(".write"));
      expect(outputWrite).toBeDefined();
      if (!outputWrite) {
        return;
      }

      const writes: number[] = [];
      const runtime = await runEffectfulExport<void>({
        wasm: wasmBytes,
        entryName: "draw_effectful",
        handlers: {
          [`${outputWrite.opIndex}`]: (_req, value: unknown) => {
            writes.push(typeof value === "number" ? value : Number(value));
            return 0;
          },
        },
      });
      expect(runtime.value).toBeNull();
      expect(writes).toEqual([7]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
