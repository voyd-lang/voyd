import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { analyzeModules } from "../../pipeline-shared.js";
import { buildModuleGraph } from "../graph.js";
import { createMemoryModuleHost } from "../memory-host.js";
import { createNodePathAdapter } from "../node-path-adapter.js";
import type { ModuleHost } from "../types.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const compileSingleModule = async (source: string) => {
  const root = resolve("/proj/src");
  const host = createMemoryHost({
    [`${root}${sep}main.voyd`]: source,
  });
  const graph = await buildModuleGraph({
    entryPath: `${root}${sep}main.voyd`,
    host,
    roots: { src: root },
  });
  const analyzed = analyzeModules({
    graph,
    recoverFromTypingErrors: true,
  });
  return {
    graph,
    semantics: analyzed.semantics,
    diagnostics: [...graph.diagnostics, ...analyzed.diagnostics],
  };
};

describe("doc comments", () => {
  it("attaches docs to declarations, members, parameters, and modules", async () => {
    const { graph, semantics, diagnostics } = await compileSingleModule(`//! Module docs.
//! More module docs.

/// Adds values.
pub fn add(
  /// Left operand.
  left: i32,
  {
    /// Right operand.
    right: i32,

    /// External label docs.
    rhs value: i32
  }
) -> i32
  left + right + value

/// Creates enums.
pub macro enum(enum_name, variants_block)
  syntax_template (void)

/// Value alias.
pub type Value = i32

/// Number box.
pub obj Box {
  /// Stored number.
  value: i32
}

/// Summable behavior.
pub trait Summable
  /// Adds another value.
  fn plus(
    /// Receiver.
    self: Self,
    /// Other value.
    other: Self
  ) -> Self

/// Box helpers.
pub impl Box
  /// Returns value.
  fn get(self) -> i32
    self.value

/// Math module docs.
pub mod math
  //! Nested docs.
  /// Returns one.
  pub fn one() -> i32
    1
`);

    expect(diagnostics.filter((entry) => entry.code === "MD0004")).toHaveLength(0);

    const mainModule = graph.modules.get("src::main");
    expect(mainModule?.docs?.module).toBe(" Module docs.\n More module docs.");
    expect(mainModule?.docs?.macroDeclarationsByName.get("enum")).toBe(
      " Creates enums.",
    );

    const mainSemantics = semantics.get("src::main");
    expect(mainSemantics).toBeDefined();
    if (!mainSemantics) {
      return;
    }

    const add = mainSemantics.binding.functions.find((fn) => fn.name === "add");
    expect(add?.documentation).toBe(" Adds values.");
    const left = add?.params.find((param) => param.name === "left");
    const right = add?.params.find((param) => param.name === "right");
    const value = add?.params.find((param) => param.name === "value");
    expect(left?.documentation).toBe(" Left operand.");
    expect(right?.documentation).toBe(" Right operand.");
    expect(value?.documentation).toBe(" External label docs.");

    const alias = mainSemantics.binding.typeAliases.find(
      (entry) => entry.name === "Value",
    );
    expect(alias?.documentation).toBe(" Value alias.");

    const objectDecl = mainSemantics.binding.objects.find(
      (entry) => entry.name === "Box",
    );
    expect(objectDecl?.documentation).toBe(" Number box.");
    const valueField = objectDecl?.fields.find((field) => field.name === "value");
    expect(valueField?.documentation).toBe(" Stored number.");

    const traitDecl = mainSemantics.binding.traits.find(
      (entry) => entry.name === "Summable",
    );
    expect(traitDecl?.documentation).toBe(" Summable behavior.");
    const plus = traitDecl?.methods.find((method) => method.name === "plus");
    expect(plus?.documentation).toBe(" Adds another value.");
    const selfParam = plus?.params.find((param) => param.name === "self");
    const otherParam = plus?.params.find((param) => param.name === "other");
    expect(selfParam?.documentation).toBe(" Receiver.");
    expect(otherParam?.documentation).toBe(" Other value.");

    const implDecl = mainSemantics.binding.impls.find(
      (entry) => entry.target && entry.documentation === " Box helpers.",
    );
    expect(implDecl?.documentation).toBe(" Box helpers.");
    const getMethod = implDecl?.methods.find((method) => method.name === "get");
    expect(getMethod?.documentation).toBe(" Returns value.");

    const mathModule = graph.modules.get("src::main::math");
    expect(mathModule?.docs?.module).toBe(" Math module docs.\n\n Nested docs.");

    const mathSemantics = semantics.get("src::main::math");
    expect(mathSemantics).toBeDefined();
    if (!mathSemantics) {
      return;
    }
    const one = mathSemantics.binding.functions.find((fn) => fn.name === "one");
    expect(one?.documentation).toBe(" Returns one.");
  });

  it("reports dangling docs separated from declarations by blank lines", async () => {
    const { diagnostics } = await compileSingleModule(`/// I am lost.

fn ok() -> i32
  1
`);

    expect(diagnostics.some((entry) => entry.code === "MD0004")).toBe(true);
  });

  it("reports docs before non-documentable statements", async () => {
    const { diagnostics } = await compileSingleModule(`fn main() -> i32
  /// Not allowed here.
  let x = 1
  x
`);

    expect(diagnostics.some((entry) => entry.code === "MD0004")).toBe(true);
  });

  it("reports dangling parameter docs when no parameter follows", async () => {
    const { diagnostics } = await compileSingleModule(`fn bad(
  /// nobody home
) -> i32
  1
`);

    expect(diagnostics.some((entry) => entry.code === "MD0004")).toBe(true);
  });

  it("allows regular comments between docs and declarations", async () => {
    const { diagnostics, semantics } = await compileSingleModule(`/// Works.
// Bridge comment.
fn ok() -> i32
  1
`);

    expect(diagnostics.filter((entry) => entry.code === "MD0004")).toHaveLength(0);
    const mainSemantics = semantics.get("src::main");
    const ok = mainSemantics?.binding.functions.find((fn) => fn.name === "ok");
    expect(ok?.documentation).toBe(" Works.");
  });

  it("allows docs before attribute lines on declarations", async () => {
    const { diagnostics, semantics } = await compileSingleModule(`/// Time effect docs.
@effect(id: "voyd.std.time")
pub eff Time
  /// Sleep docs.
  sleep(tail, ms: i64) -> i64
`);

    expect(diagnostics.filter((entry) => entry.code === "MD0004")).toHaveLength(0);
    const mainSemantics = semantics.get("src::main");
    const effectDecl = mainSemantics?.binding.effects.find(
      (effect) => effect.name === "Time",
    );
    expect(effectDecl?.documentation).toBe(" Time effect docs.");
    const sleepOp = effectDecl?.operations.find((op) => op.name === "sleep");
    expect(sleepOp?.documentation).toBe(" Sleep docs.");
  });
});
