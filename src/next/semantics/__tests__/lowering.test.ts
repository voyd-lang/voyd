import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { createSymbolTable } from "../binder/index.js";
import { runBindingPipeline } from "../binding/pipeline.js";
import { createHirBuilder } from "../hir/builder.js";
import {
  type HirBlockExpr,
  type HirFunction,
  type HirIfExpr,
} from "../hir/nodes.js";
import { runLoweringPipeline } from "../lowering/pipeline.js";
import { toSourceSpan } from "../utils.js";

const loadModuleAst = (relPath: string) => {
  const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
  return parse(source, relPath);
};

describe("lowering pipeline", () => {
  it("lowers the fib sample module into HIR", () => {
    const relPath = "sb/fib.voyd";
    const ast = loadModuleAst(relPath);
    const symbolTable = createSymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name: relPath,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
    });
    const builder = createHirBuilder({
      path: relPath,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
    });

    expect(hir.module.items).toHaveLength(2);

    const fibSymbol = symbolTable.resolve("fib", symbolTable.rootScope);
    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope);

    const fibFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction => item.kind === "function" && item.symbol === fibSymbol
    );
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction => item.kind === "function" && item.symbol === mainSymbol
    );

    expect(fibFn).toBeDefined();
    expect(mainFn).toBeDefined();

    expect(fibFn?.parameters).toHaveLength(1);
    const fibBlock = hir.expressions.get(fibFn!.body)!;
    expect(fibBlock.exprKind).toBe("block");
    const fibIf = hir.expressions.get((fibBlock as HirBlockExpr).value!) as HirIfExpr;
    expect(fibIf.exprKind).toBe("if");
    expect(fibIf.branches).toHaveLength(1);
    expect(fibIf.defaultBranch).toBeDefined();

    expect(mainFn?.visibility).toBe("public");
    expect(hir.module.exports.map((entry) => entry.symbol)).toEqual([mainSymbol]);
  });
});
