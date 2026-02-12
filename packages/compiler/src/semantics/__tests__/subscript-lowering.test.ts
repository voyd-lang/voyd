import { describe, expect, it } from "vitest";
import { SymbolTable } from "../binder/index.js";
import { runBindingPipeline } from "../binding/binding.js";
import { createHirBuilder } from "../hir/builder.js";
import type {
  HirFunction,
  HirMethodCallExpr,
  HirObjectLiteralExpr,
} from "../hir/nodes.js";
import { runLoweringPipeline } from "../lowering/lowering.js";
import { toSourceSpan } from "../utils.js";
import { loadAst } from "./load-ast.js";

const lowerFixture = (fixtureName: string) => {
  const ast = loadAst(fixtureName);
  const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
  const moduleSymbol = symbolTable.declare({
    name: fixtureName,
    kind: "module",
    declaredAt: ast.syntaxId,
  });
  const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
  const builder = createHirBuilder({
    path: fixtureName,
    scope: moduleSymbol,
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
  });
  const hir = runLoweringPipeline({
    builder,
    binding,
    moduleNodeId: ast.syntaxId,
    modulePath: binding.modulePath,
    packageId: binding.packageId,
    isPackageRoot: binding.isPackageRoot,
  });

  return { hir, symbolTable };
};

describe("subscript lowering", () => {
  it("lowers read and write subscripts into method calls", () => {
    const { hir, symbolTable } = lowerFixture("subscript.voyd");
    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope);
    expect(typeof mainSymbol).toBe("number");

    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();

    const methodCalls = Array.from(hir.expressions.values()).filter(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" &&
        (expr.method === "subscript_get" || expr.method === "subscript_set")
    );

    expect(methodCalls.some((call) => call.method === "subscript_get")).toBe(
      true
    );
    expect(methodCalls.some((call) => call.method === "subscript_set")).toBe(
      true
    );

    const setCall = methodCalls.find((call) => call.method === "subscript_set");
    expect(setCall?.args).toHaveLength(2);
  });

  it("lowers range operators into nominal Range object literals", () => {
    const { hir } = lowerFixture("subscript.voyd");
    const subscriptCalls = Array.from(hir.expressions.values()).filter(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" && expr.method === "subscript_get"
    );

    const withRangeArg = subscriptCalls.find((call) => {
      const arg = call.args[0];
      if (!arg) return false;
      return hir.expressions.get(arg.expr)?.exprKind === "object-literal";
    });
    expect(withRangeArg).toBeDefined();
    if (!withRangeArg) return;

    const rangeArg = hir.expressions.get(
      withRangeArg.args[0]!.expr
    ) as HirObjectLiteralExpr;
    expect(rangeArg.exprKind).toBe("object-literal");
    expect(rangeArg.literalKind).toBe("structural");
    const fieldNames = rangeArg.entries
      .filter((entry) => entry.kind === "field")
      .map((entry) => entry.name)
      .sort();
    expect(fieldNames).toEqual(["end", "include_end", "start"]);
  });
});
