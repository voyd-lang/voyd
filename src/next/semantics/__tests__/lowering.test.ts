import { describe, expect, it } from "vitest";
import { SymbolTable } from "../binder/index.js";
import { runBindingPipeline } from "../binding/binding.js";
import { createHirBuilder } from "../hir/builder.js";
import {
  type HirBlockExpr,
  type HirCallExpr,
  type HirFieldAccessExpr,
  type HirFunction,
  type HirIdentifierExpr,
  type HirIfExpr,
  type HirLetStatement,
  type HirObjectLiteralExpr,
  type HirTypeAlias,
} from "../hir/nodes.js";
import { runLoweringPipeline } from "../lowering/lowering.js";
import { toSourceSpan } from "../utils.js";
import { loadAst } from "./load-ast.js";

describe("lowering pipeline", () => {
  it("lowers the fib sample module into HIR", () => {
    const name = "fib.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({
      moduleForm: ast,
      symbolTable,
    });
    const builder = createHirBuilder({
      path: name,
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
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === fibSymbol
    );
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );

    expect(fibFn).toBeDefined();
    expect(mainFn).toBeDefined();

    expect(fibFn?.parameters).toHaveLength(1);
    const fibBlock = hir.expressions.get(fibFn!.body)!;
    expect(fibBlock.exprKind).toBe("block");
    const fibIf = hir.expressions.get(
      (fibBlock as HirBlockExpr).value!
    ) as HirIfExpr;
    expect(fibIf.exprKind).toBe("if");
    expect(fibIf.branches).toHaveLength(1);
    expect(fibIf.defaultBranch).toBeDefined();

    expect(mainFn?.visibility).toBe("public");
    expect(hir.module.exports.map((entry) => entry.symbol)).toEqual([
      mainSymbol,
    ]);
  });

  it("lowers structural object declarations and expressions", () => {
    const name = "structural_objects.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
    });

    const alias = Array.from(hir.items.values()).find(
      (item): item is HirTypeAlias => item.kind === "type-alias"
    );
    expect(alias).toBeDefined();
    expect(alias?.target.typeKind).toBe("object");
    if (alias?.target.typeKind === "object") {
      const fieldNames = alias.target.fields.map((field) => field.name);
      expect(fieldNames).toEqual(["x", "y", "z"]);
    }

    const addSymbol = symbolTable.resolve("add", symbolTable.rootScope)!;
    const addFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === addSymbol
    );
    expect(addFn).toBeDefined();
    const addParamType = addFn?.parameters[0]?.type;
    expect(addParamType?.typeKind).toBe("named");
    if (addParamType?.typeKind === "named") {
      expect(addParamType.path).toEqual(["MyVec"]);
    }

    const addBody = hir.expressions.get(addFn!.body)!;
    expect(addBody.exprKind).toBe("block");
    const addValue = (addBody as HirBlockExpr).value;
    expect(addValue).toBeDefined();
    const addCall = hir.expressions.get(addValue!) as HirCallExpr;
    expect(addCall.exprKind).toBe("call");
    const firstField = hir.expressions.get(addCall.args[0]!.expr)!;
    expect(firstField.exprKind).toBe("field-access");
    expect((firstField as HirFieldAccessExpr).field).toBe("x");

    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope)!;
    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();
    const mainBlock = hir.expressions.get(mainFn!.body)!;
    expect(mainBlock.exprKind).toBe("block");
    const blockExpr = mainBlock as HirBlockExpr;
    const secondStmt = hir.statements.get(blockExpr.statements[1]!)!;
    expect(secondStmt.kind).toBe("let");
    const letStmt = secondStmt as HirLetStatement;
    const initializer = hir.expressions.get(letStmt.initializer)!;
    expect(initializer.exprKind).toBe("object-literal");
    const objectLiteral = initializer as HirObjectLiteralExpr;
    expect(objectLiteral.entries.some((entry) => entry.kind === "spread")).toBe(
      true
    );
  });

  it("lowers UFCS calls into plain function calls", () => {
    const name = "ufcs.voyd";
    const ast = loadAst(name);
    const symbolTable = new SymbolTable({ rootOwner: ast.syntaxId });
    const moduleSymbol = symbolTable.declare({
      name,
      kind: "module",
      declaredAt: ast.syntaxId,
    });
    const binding = runBindingPipeline({ moduleForm: ast, symbolTable });
    const builder = createHirBuilder({
      path: name,
      scope: moduleSymbol,
      ast: ast.syntaxId,
      span: toSourceSpan(ast),
    });

    const hir = runLoweringPipeline({
      builder,
      binding,
      moduleNodeId: ast.syntaxId,
    });

    const sumSymbol = symbolTable.resolve("sum", symbolTable.rootScope)!;
    const mainSymbol = symbolTable.resolve("main", symbolTable.rootScope)!;

    const mainFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === mainSymbol
    );
    expect(mainFn).toBeDefined();

    const sumCalls = Array.from(hir.expressions.values()).filter(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") return false;
        const callee = hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" &&
          (callee as HirIdentifierExpr).symbol === sumSymbol
        );
      }
    );

    expect(sumCalls).toHaveLength(2);
    const argNames = sumCalls.map((call) => {
      expect(call.args).toHaveLength(1);
      const argExpr = hir.expressions.get(call.args[0]!.expr);
      expect(argExpr?.exprKind).toBe("identifier");
      return symbolTable.getSymbol((argExpr as HirIdentifierExpr).symbol).name;
    });

    expect(argNames.sort()).toEqual(["v1", "v2"]);
  });
});
