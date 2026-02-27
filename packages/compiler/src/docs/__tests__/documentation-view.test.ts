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

/// Builds enum declarations.
pub macro enum(enum_name, variants_block)
  syntax_template (void)

pub obj Num {
  api value: i32
  hidden: i32
}

impl Num
  api fn double(~self) -> i32
    self.value * 2

  fn hide(self) -> i32
    self.value

pub eff Decode
  /// Decode next value.
  decode_next(resume, input: i32) -> i32
  finish(tail) -> void

pub use src::main::math::all

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
    const enumMacro = mainModule?.macros.find((macro) => macro.name === "enum");
    expect(enumMacro).toBeDefined();
    expect(enumMacro?.documentation).toBe(" Builds enum declarations.");
    const addFn = mainModule?.functions.find((fn) => fn.name === "add");
    expect(addFn?.documentation).toBe(" Adds values.");
    const leftParam = addFn?.params.find((param) => param.name === "left");
    expect(leftParam?.documentation).toBe(" Left docs.\n Keep newline.");
    const numObject = mainModule?.objects.find((objectDecl) => objectDecl.name === "Num");
    expect(numObject?.fields.map((field) => field.name)).toEqual(["value"]);
    const decodeEffect = mainModule?.effects.find((effect) => effect.name === "Decode");
    expect(decodeEffect).toBeDefined();
    expect(decodeEffect?.operations.map((op) => op.name)).toEqual([
      "decode_next",
      "finish",
    ]);
    const decodeNextOp = decodeEffect?.operations.find(
      (op) => op.name === "decode_next",
    );
    expect(decodeNextOp?.documentation).toBe(" Decode next value.");
    const mathReExport = mainModule?.reexports.find(
      (reexport) => reexport.path.join("::") === "src::main::math",
    );
    expect(mathReExport?.selectionKind).toBe("all");
    const implMethod = mainModule?.functions.find((fn) => fn.name === "double");
    const implDecl = mainModule?.impls[0];
    expect(implMethod?.implId).toBe(implDecl?.id);
    expect(implDecl?.methods.some((method) => method.name === "double")).toBe(
      true,
    );
    const doubleMethod = implDecl?.methods.find((method) => method.name === "double");
    const selfParam = doubleMethod?.params.find((param) => param.name === "self");
    expect(selfParam?.mutable).toBe(true);
    expect(implDecl?.methods.some((method) => method.name === "hide")).toBe(
      false,
    );
  });

  it("only includes modules exported by pkg.voyd when entry is a package root", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}pkg.voyd`]: `pub use self::visible::all

mod hidden
  pub fn internal() -> i32
    0

pub mod visible
  mod hidden_nested
    pub fn never_seen() -> i32
      0

  pub mod nested
    pub fn deep() -> i32
      2

  pub fn shown() -> i32
    1
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}pkg.voyd`,
      host,
      roots: { src: root },
    });
    const { semantics, diagnostics } = analyzeModules({ graph });
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toHaveLength(0);

    const view = buildDocumentationView({ graph, semantics });
    expect(view.entryModule).toBe("src::pkg");
    expect(view.modules.map((module) => module.id)).toEqual([
      "src::pkg",
      "src::pkg::visible",
      "src::pkg::visible::nested",
    ]);
  });
});
