import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import { analyzeModules, loadModuleGraph } from "../pipeline.js";
import type { ModuleHost } from "../modules/types.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

describe("test companions", () => {
  it("merges src/*.test.voyd into its companion module in test builds", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
use src::math::all

pub fn main() -> i32
  value()
`,
      [`${root}${sep}math.voyd`]: `
fn hidden() -> i32
  7

pub fn value() -> i32
  hidden()
`,
      [`${root}${sep}math.test.voyd`]: `
test "companion can access private symbols":
  hidden()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
      includeTests: true,
    });

    expect(graph.modules.has("src::math")).toBe(true);
    expect(graph.modules.has("src::math.test")).toBe(false);

    const { diagnostics, tests } = analyzeModules({ graph, includeTests: true });
    expect(diagnostics).toHaveLength(0);
    expect(tests).toHaveLength(1);
    expect(tests[0]?.moduleId).toBe("src::math");
  });

  it("does not load src/*.test.voyd in non-test builds", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
use src::math::all

pub fn main() -> i32
  value()
`,
      [`${root}${sep}math.voyd`]: `
pub fn value() -> i32
  7
`,
      [`${root}${sep}math.test.voyd`]: `
test "ignored in normal builds":
  value()
`,
    });

    const graph = await loadModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
      includeTests: false,
    });

    expect(graph.modules.has("src::math")).toBe(true);
    expect(graph.modules.has("src::math.test")).toBe(false);

    const { diagnostics, tests } = analyzeModules({ graph, includeTests: true });
    expect(diagnostics).toHaveLength(0);
    expect(tests).toHaveLength(0);
  });
});
