import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { buildModuleGraph } from "../graph.js";
import { createMemoryModuleHost } from "../memory-host.js";
import { createNodePathAdapter } from "../node-path-adapter.js";
import {
  analyzeModuleSemantics,
  isSemanticsAnalysisCancelledError,
} from "../semantic-analysis.js";
import type { ModuleHost } from "../types.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const createGraph = async ({
  files,
  entryPath,
}: {
  files: Record<string, string>;
  entryPath: string;
}) => {
  const host = createMemoryHost(files);
  return buildModuleGraph({
    entryPath,
    host,
    roots: {
      src: resolve("/proj/src"),
    },
  });
};

describe("analyzeModuleSemantics", () => {
  it("recomputes only changed modules and reverse dependents", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}main.voyd`;
    const initialGraph = await createGraph({
      entryPath,
      files: {
        [entryPath]:
          `use src::util::value\nuse src::helper::helper\n\nfn main() -> i32\n  value() + helper()\n`,
        [`${root}${sep}util.voyd`]: `pub fn value() -> i32\n  1\n`,
        [`${root}${sep}helper.voyd`]: `pub fn helper() -> i32\n  2\n`,
      },
    });
    const initial = analyzeModuleSemantics({
      graph: initialGraph,
      recoverFromTypingErrors: true,
    });

    const updatedGraph = await createGraph({
      entryPath,
      files: {
        [entryPath]:
          `use src::util::value\nuse src::helper::helper\n\nfn main() -> i32\n  value() + helper()\n`,
        [`${root}${sep}util.voyd`]: `pub fn value() -> i32\n  10\n`,
        [`${root}${sep}helper.voyd`]: `pub fn helper() -> i32\n  2\n`,
      },
    });
    const updated = analyzeModuleSemantics({
      graph: updatedGraph,
      previousSemantics: initial.semantics,
      changedModuleIds: new Set(["src::util"]),
      recoverFromTypingErrors: true,
    });

    expect(updated.recomputedModuleIds).toEqual(
      expect.arrayContaining(["src::main", "src::util"]),
    );
    expect(updated.recomputedModuleIds).not.toContain("src::helper");
    expect(updated.semantics.get("src::helper")).toBe(initial.semantics.get("src::helper"));
    expect(updated.semantics.get("src::main")).not.toBe(initial.semantics.get("src::main"));
    expect(updated.semantics.get("src::util")).not.toBe(initial.semantics.get("src::util"));
  });

  it("falls back to full recompute for unknown changed module ids", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}main.voyd`;
    const graph = await createGraph({
      entryPath,
      files: {
        [entryPath]: `fn main() -> i32\n  1\n`,
      },
    });
    const initial = analyzeModuleSemantics({
      graph,
      recoverFromTypingErrors: true,
    });

    const updated = analyzeModuleSemantics({
      graph,
      previousSemantics: initial.semantics,
      changedModuleIds: new Set(["src::does_not_exist"]),
      recoverFromTypingErrors: true,
    });

    expect(updated.recomputedModuleIds.length).toBe(graph.modules.size);
  });

  it("supports cancellation before semantics work begins", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}main.voyd`;
    const graph = await createGraph({
      entryPath,
      files: {
        [entryPath]: `fn main() -> i32\n  1\n`,
      },
    });

    const run = () =>
      analyzeModuleSemantics({
        graph,
        recoverFromTypingErrors: true,
        isCancelled: () => true,
      });

    expect(run).toThrow();
    try {
      run();
    } catch (error) {
      expect(isSemanticsAnalysisCancelledError(error)).toBe(true);
    }
  });
});
