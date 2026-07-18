import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../memory-host.js";
import { createNodePathAdapter } from "../node-path-adapter.js";
import type { ModuleHost } from "../types.js";
import { buildModuleGraph } from "../graph.js";
import { isIntAtom } from "../../parser/index.js";
import { analyzeModules } from "../../pipeline-shared.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

describe("expandModuleMacros diagnostics", () => {
  it("preserves previously exported macros after later expansion failures", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: [
        "use src::macros::keep",
        "keep(41)",
      ].join("\n"),
      [`${root}${sep}macros.voyd`]: [
        "pub macro keep(x)",
        "  x",
        "keep()",
      ].join("\n"),
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0003");
    expect(diagnostic).toBeTruthy();
    const mainModule = graph.modules.get("src::main");
    expect(mainModule).toBeTruthy();
    const lastExpr = mainModule?.ast.last;
    expect(isIntAtom(lastExpr) ? lastExpr.value : null).toBe("41");
  });

  it("reports functional macro expansion errors as module-graph diagnostics", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: [
        "macro m(x)",
        "  x",
        "m()",
      ].join("\n"),
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0003");
    expect(diagnostic).toBeTruthy();
    expect(diagnostic?.message).toMatch(/functionalMacroExpander/i);
    expect(diagnostic?.message).toMatch(/expected 1 arguments/i);
    expect(diagnostic?.span.file).toContain("main.voyd");
  });

  it("reports invalid macro signatures as module-graph diagnostics", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: [
        "macro broken",
        "  syntax_template ok",
      ].join("\n"),
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0003");
    expect(diagnostic).toBeTruthy();
    expect(diagnostic?.message).toMatch(/macro signature/i);
    expect(diagnostic?.span.file).toContain("main.voyd");
  });

  it("reports @serializer macro errors as module-graph diagnostics", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: [
        '@serializer("msgpack", encode, decode)',
        '@serializer("msgpack", encode, decode)',
        "pub type Foo = i32",
      ].join("\n"),
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0003");
    expect(diagnostic).toBeTruthy();
    expect(diagnostic?.message).toMatch(/serializer/i);
    expect(diagnostic?.message).toMatch(/duplicate/i);
    expect(diagnostic?.span.file).toContain("main.voyd");
  });

  it("reports unknown declaration attributes at the invocation", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
@missing
fn value() -> i32
  1
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0003");
    expect(diagnostic?.message).toMatch(/unknown attribute '@missing'/i);
    expect(diagnostic?.span.start).toBe(2);
  });

  it("does not cascade surface errors for unknown method attributes", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
obj Box {}

impl Box
  @missing
  fn value(self) -> i32
    1
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "MD0003",
        message: expect.stringMatching(/unknown attribute '@missing'/i),
      }),
    ]);
  });

  it("reports ambiguous imported attribute macros and recommends aliases", async () => {
    const root = resolve("/proj/src");
    const attributeMacro = `
pub attribute macro decorate(args, declaration)
  declaration
`;
    const source = `
use src::first::all
use src::second::all

@decorate
fn value() -> i32
  1
`;
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: source,
      [`${root}${sep}first.voyd`]: attributeMacro,
      [`${root}${sep}second.voyd`]: attributeMacro,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0003");
    expect(diagnostic?.message).toMatch(/macro 'decorate' is ambiguous/i);
    expect(diagnostic?.message).toMatch(/explicit alias/i);
    expect(diagnostic?.span.start).toBe(source.indexOf("@decorate"));
    expect(graph.diagnostics.some((entry) => entry.code === "MD0002")).toBe(false);
  });

  it("preserves attribute macro ambiguity through public re-exports", async () => {
    const root = resolve("/proj/src");
    const attributeMacro = `
pub attribute macro decorate(args, declaration)
  declaration
`;
    const source = `
use src::barrel::all

@decorate
fn value() -> i32
  1
`;
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: source,
      [`${root}${sep}barrel.voyd`]: `
pub use src::first::all
pub use src::second::all
`,
      [`${root}${sep}first.voyd`]: attributeMacro,
      [`${root}${sep}second.voyd`]: attributeMacro,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0003");
    expect(diagnostic?.message).toMatch(/macro 'decorate' is ambiguous/i);
    expect(diagnostic?.span.start).toBe(source.indexOf("@decorate"));
  });

  it("reports attribute macro ambiguity introduced by generated imports", async () => {
    const root = resolve("/proj/src");
    const attributeMacro = `
pub attribute macro decorate(args, declaration)
  declaration
`;
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
use src::first::all

macro import_second()
  syntax_template (use src::second::all)

import_second()

@decorate
fn value() -> i32
  1
`,
      [`${root}${sep}first.voyd`]: attributeMacro,
      [`${root}${sep}second.voyd`]: attributeMacro,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0003");
    expect(diagnostic?.message).toMatch(/macro 'decorate' is ambiguous/i);
    expect(diagnostic?.message).toMatch(/explicit alias/i);
  });

  it.each([
    {
      name: "duplicate attribute",
      declarations: `
attribute macro preserve(args, declaration)
  declaration
`,
      attributes: "@preserve\n@preserve",
      expectedMessage: /duplicate user-defined attribute/i,
    },
    {
      name: "functional macro used as an attribute",
      declarations: `
macro preserve(value)
  value
`,
      attributes: "@preserve",
      expectedMessage: /functional macro, not an attribute macro/i,
    },
  ])(
    "recovers from $name without cascading or blocking later expansion",
    async ({ declarations, attributes, expectedMessage }) => {
      const root = resolve("/proj/src");
      const host = createMemoryHost({
        [`${root}${sep}main.voyd`]: `
${declarations}
macro declare_helper()
  \`(fn helper() -> i32
    2)

${attributes}
fn value() -> i32
  1

declare_helper()
`,
      });

      const graph = await buildModuleGraph({
        entryPath: `${root}${sep}main.voyd`,
        host,
        roots: { src: root },
      });

      expect(graph.diagnostics).toEqual([
        expect.objectContaining({
          code: "MD0003",
          message: expect.stringMatching(expectedMessage),
        }),
      ]);
      const functionNames = graph.modules
        .get("src::main")
        ?.surface?.items.flatMap((item) =>
          item.kind === "function"
            ? [item.declaration.signature.name.value]
            : [],
        );
      expect(functionNames).toEqual(["value", "helper"]);
    },
  );

  it("rolls back generated macro exports when an attribute expansion fails", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
macro requires_value(value)
  value

attribute macro broken(args, declaration)
  emit_many(
    \`(pub macro ghost(value)
      value),
    \`(requires_value())
  )

@broken
fn value() -> i32
  1
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    expect(graph.diagnostics).toEqual([
      expect.objectContaining({
        code: "MD0003",
        message: expect.stringMatching(/expected 1 arguments, received 0/i),
      }),
    ]);
    const module = graph.modules.get("src::main");
    expect(module?.macroExports).not.toContain("ghost");
    expect(
      module?.surface?.items.some((item) => item.kind === "function"),
    ).toBe(true);
  });

  it("rejects compiler-reserved attribute macro names", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `
attribute macro external(args, declaration)
  declaration
`,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0003");
    expect(diagnostic?.message).toMatch(
      /attribute macro name 'external' is reserved/i,
    );
  });

  it("maps diagnostics from generated declarations to the attribute invocation", async () => {
    const root = resolve("/proj/src");
    const source = `
attribute macro invalid(args, declaration)
  \`(not_a_declaration generated)

@invalid
fn value() -> i32
  1
`;
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: source,
    });

    const graph = await buildModuleGraph({
      entryPath: `${root}${sep}main.voyd`,
      host,
      roots: { src: root },
    });

    const diagnostic = graph.diagnostics.find((entry) => entry.code === "MD0002");
    expect(diagnostic?.message).toMatch(/unsupported top-level form/i);
    expect(diagnostic?.span.start).toBe(source.indexOf("@invalid"));
  });

  it("maps nested generated binding diagnostics to the attribute invocation", async () => {
    const root = resolve("/proj/src");
    const source = `
attribute macro invalid(args, declaration)
  \`(fn generated() -> i32
    missing_value)

@invalid
fn value() -> i32
  1
`;
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

    const diagnostic = analyzed.diagnostics.find((entry) =>
      entry.message.includes("missing_value"),
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.span.start).toBe(source.indexOf("@invalid"));
  });
});
