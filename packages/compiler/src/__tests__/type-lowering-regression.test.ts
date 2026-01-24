import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { parse } from "../parser/index.js";
import { semanticsPipeline } from "../semantics/pipeline.js";
import { codegen } from "../codegen/index.js";
import { wasmTypeFor } from "../codegen/types.js";
import { createTestCodegenContext } from "../codegen/__tests__/support/test-codegen-context.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleGraph, ModuleHost, ModuleNode } from "../modules/types.js";
import { compileProgram } from "../pipeline.js";
import { modulePathToString } from "../modules/path.js";
import type { HirLambdaExpr } from "../semantics/hir/index.js";
import { getSymbolTable } from "../semantics/_internal/symbol-table.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

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

  it("does not capture imported values in lambdas", () => {
    const buildModule = ({
      source,
      segments,
      dependencies = [],
    }: {
      source: string;
      segments: readonly string[];
      dependencies?: ModuleNode["dependencies"];
    }): ModuleNode => {
      const path = { namespace: "src" as const, segments };
      const id = modulePathToString(path);
      const ast = parse(source, id);
      return {
        id,
        path,
        origin: { kind: "file", filePath: id },
        ast,
        source,
        dependencies,
      };
    };

    const dep = buildModule({
      source: `pub fn add(a: i32, b: i32) -> i32
  a + b
`,
      segments: ["dep"],
    });
    const main = buildModule({
      source: `use dep::{ add }

pub fn main() -> i32
  let thunk = () -> i32 =>
    add(1, 2)
  thunk()
`,
      segments: ["main"],
      dependencies: [{ kind: "use", path: dep.path }],
    });

    const graph: ModuleGraph = {
      entry: main.id,
      modules: new Map([
        [main.id, main],
        [dep.id, dep],
      ]),
      diagnostics: [],
    };

    const depSemantics = semanticsPipeline({ module: dep, graph });
    const semantics = semanticsPipeline({
      module: main,
      graph,
      exports: new Map([[dep.id, depSemantics.exports]]),
      dependencies: new Map([[dep.id, depSemantics]]),
    });

    const symbolTable = getSymbolTable(semantics);
    const lambda = Array.from(semantics.hir.expressions.values()).find(
      (expr): expr is HirLambdaExpr => expr.exprKind === "lambda"
    );
    expect(lambda).toBeDefined();
    const captureNames = (lambda?.captures ?? []).map(
      (capture) => symbolTable.getSymbol(capture.symbol).name
    );
    expect(captureNames).toEqual([]);
  });

  it("emits wasm for recursive data types", () => {
    const source = `obj Box<T> {
  v: T
}

obj None<T> {}

type List<T> = Box<List<T>> | None<T>

fn depth(l: List<i32>) -> i32
  l.match()
    Box<List<i32>>: 1 + depth(l.v)
    None<i32>: 0
    else: -1

pub fn main() -> i32
  let list = Box<List<i32>> { v: Box<List<i32>> { v: None<i32> {} } }
  list.depth()
`;
    const ast = parse(source, "/proj/src/recursive_list_regression.voyd");
    const semantics = semanticsPipeline(ast);
    const { module, diagnostics } = codegen(semantics);
    if (diagnostics.length > 0) {
      throw new Error(JSON.stringify(diagnostics, null, 2));
    }
    const instance = getWasmInstance(module);
    expect((instance.exports.main as () => number)()).toBe(2);
  });

  it("links cross-module trait impls without order hazards", async () => {
    const root = resolve("/proj/src");
    const host = createMemoryHost({
      [`${root}${sep}main.voyd`]: `use traits::{ Countable }
use impls::{ Box }

pub fn main() -> i32
  let value = Box { value: 41 }
  value.count() + 1
`,
      [`${root}${sep}traits.voyd`]: `pub trait Countable
  fn count(self) -> i32
`,
      [`${root}${sep}impls.voyd`]: `use traits::{ Countable }

pub obj Box {
  value: i32,
}

impl Countable for Box
  fn count(self) -> i32
    self.value
`,
    });

    const result = await compileProgram({
      entryPath: `${root}${sep}main.voyd`,
      roots: { src: root },
      host,
    });

    if (result.diagnostics.length > 0) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
    expect(result.wasm).toBeInstanceOf(Uint8Array);
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });
});
