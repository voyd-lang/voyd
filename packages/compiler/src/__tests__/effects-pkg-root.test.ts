import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

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
});
