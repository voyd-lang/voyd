import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { createMemoryModuleHost } from "../memory-host.js";
import { createNodePathAdapter } from "../node-path-adapter.js";
import type { ModuleHost } from "../types.js";
import { buildModuleGraph } from "../graph.js";
import { isIntAtom } from "../../parser/index.js";

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
});
