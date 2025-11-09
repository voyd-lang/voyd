import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import {
  type HirBlockExpr,
  type HirFunction,
  type HirIfExpr,
  type HirNamedTypeExpr,
} from "../hir/nodes.js";
import { semanticsPipeline } from "../pipeline.js";

describe("semanticsPipeline", () => {
  it("binds and lowers the fib sample module", () => {
    const relPath = "sb/fib.voyd";
    const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
    const ast = parse(source, relPath);
    const result = semanticsPipeline(ast);

    const { symbolTable, hir } = result;
    expect(hir.module.path).toBe(relPath);
    expect(hir.module.items).toHaveLength(2);

    const rootScope = symbolTable.rootScope;
    const fibSymbol = symbolTable.resolve("fib", rootScope);
    const mainSymbol = symbolTable.resolve("main", rootScope);
    expect(fibSymbol).toBeDefined();
    expect(mainSymbol).toBeDefined();

    const fibId = fibSymbol!;
    const mainId = mainSymbol!;

    expect(symbolTable.getSymbol(fibId).kind).toBe("value");
    expect(symbolTable.getSymbol(mainId).kind).toBe("value");

    const fibFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === fibId
    );
    expect(fibFn).toBeDefined();
    expect(fibFn?.parameters).toHaveLength(1);

    const fibParam = fibFn!.parameters[0];
    expect(fibParam.type?.typeKind).toBe("named");
    expect((fibParam.type as HirNamedTypeExpr).path).toEqual(["i32"]);
    expect((fibFn!.returnType as HirNamedTypeExpr).path).toEqual(["i32"]);
    expect(symbolTable.getSymbol(fibParam.symbol).kind).toBe("parameter");

    const fibBlock = hir.expressions.get(fibFn!.body)!;
    expect(fibBlock.exprKind).toBe("block");
    const fibIf = hir.expressions.get((fibBlock as HirBlockExpr).value!)!;
    expect(fibIf.exprKind).toBe("if");
    const ifNode = fibIf as HirIfExpr;
    expect(ifNode.branches).toHaveLength(1);
    expect(ifNode.branches[0]?.condition).toBeDefined();
    expect(ifNode.branches[0]?.value).toBeDefined();
    expect(ifNode.defaultBranch).toBeDefined();

    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainId
    );
    expect(mainFn).toBeDefined();
    expect(mainFn?.visibility).toBe("public");
    expect(hir.module.exports.map((entry) => entry.symbol)).toContain(mainId);

    const mainBlock = hir.expressions.get(mainFn!.body)!;
    expect(mainBlock.exprKind).toBe("block");
    const callExpr = hir.expressions.get((mainBlock as HirBlockExpr).value!)!;
    expect(callExpr.exprKind).toBe("call");
  });

  it("binds and lowers the fib sample module", () => {
    const relPath = "sb/fib.voyd";
    const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
    const ast = parse(source, relPath);
    const result = semanticsPipeline(ast);
    expect(result.hir).toMatchSnapshot();
    expect(result.symbolTable.snapshot()).toMatchSnapshot();
  });
});
