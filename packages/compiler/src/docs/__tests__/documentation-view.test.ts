import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { analyzeModules } from "../../pipeline-shared.js";
import { buildModuleGraph } from "../../modules/graph.js";
import { createMemoryModuleHost } from "../../modules/memory-host.js";
import { createNodePathAdapter } from "../../modules/node-path-adapter.js";
import type { ModuleHost } from "../../modules/types.js";
import { buildDocumentationView } from "../documentation-view.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

describe("documentation view", () => {
  it("builds a typed module/declaration view for documentation output", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `//! Package docs.

/// Adds values.
pub fn add(
  /// Left docs.
  /// Keep newline.
  left: i32
) -> i32
  left

pub eff Decode
  decode_next(resume, input: i32) -> i32
  finish(tail) -> void

/// Nested docs.
pub mod math
  /// Returns one.
  pub fn one() -> i32
    1
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });
    const { semantics, diagnostics } = analyzeModules({ graph });
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toHaveLength(0);

    const view = buildDocumentationView({ graph, semantics });
    expect(view.entryModule).toBe("src::main");
    expect(view.modules.map((module) => module.id)).toEqual([
      "src::main",
      "src::main::math",
    ]);

    const mainModule = view.modules.find((module) => module.id === "src::main");
    expect(mainModule?.documentation).toBe(" Package docs.");
    const addFn = mainModule?.functions.find((fn) => fn.name === "add");
    expect(addFn?.documentation).toBe(" Adds values.");
    const leftParam = addFn?.params.find((param) => param.name === "left");
    expect(leftParam?.documentation).toBe(" Left docs.\n Keep newline.");
    const decodeEffect = mainModule?.effects.find((effect) => effect.name === "Decode");
    expect(decodeEffect).toBeDefined();
    expect(decodeEffect?.operations.map((op) => op.name)).toEqual([
      "decode_next",
      "finish",
    ]);
  });
});
