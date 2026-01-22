import { describe, expect, it } from "vitest";
import { loadAst } from "./load-ast.js";
import { modulePathToString } from "../../modules/path.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";
import { semanticsPipeline } from "../pipeline.js";
import type { HirLambdaExpr } from "../hir/index.js";
import { getSymbolTable } from "../_internal/symbol-table.js";

const buildModuleNode = ({
  fixture,
  segments,
  dependencies = [],
}: {
  fixture: string;
  segments: readonly string[];
  dependencies?: ModuleNode["dependencies"];
}): ModuleNode => {
  const ast = loadAst(fixture);
  const path = { namespace: "src" as const, segments };
  const id = modulePathToString(path);
  return {
    id,
    path,
    origin: { kind: "file", filePath: fixture },
    ast,
    source: "",
    dependencies,
  };
};

describe("lambda captures", () => {
  it("does not capture imported values", () => {
    const dep = buildModuleNode({
      fixture: "lambda_imports/dep.voyd",
      segments: ["dep"],
    });
    const main = buildModuleNode({
      fixture: "lambda_imports/main.voyd",
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
    const exports = new Map([[dep.id, depSemantics.exports]]);
    const dependencies = new Map([[dep.id, depSemantics]]);
    const semantics = semanticsPipeline({ module: main, graph, exports, dependencies });

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
});

