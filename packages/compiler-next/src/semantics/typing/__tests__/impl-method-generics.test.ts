import { describe, expect, it } from "vitest";
import type { HirCallExpr } from "../../hir/nodes.js";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("impl method generics", () => {
  it("binds explicit type arguments to method generics before impl generics", () => {
    const ast = loadAst("impl_method_generics.voyd");
    const { symbolTable, hir, typing } = semanticsPipeline(ast);
    const root = symbolTable.rootScope;

    const pickSymbol = symbolTable.resolve("pick", root);
    const mainSymbol = symbolTable.resolve("main", root);
    expect(pickSymbol).toBeDefined();
    expect(mainSymbol).toBeDefined();

    const pickCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" && callee.symbol === pickSymbol
        );
      }
    );
    expect(pickCall).toBeDefined();

    const callType = typing.table.getExprType(pickCall!.id);
    expect(callType).toBeDefined();
    const callDesc = typing.arena.get(callType!);
    expect(callDesc.kind).toBe("primitive");
    if (callDesc.kind !== "primitive") {
      return;
    }
    expect(callDesc.name).toBe("bool");

    const typeArgs = typing.callTypeArguments.get(pickCall!.id);
    expect(typeArgs).toBeDefined();
    const boolType = typing.arena.internPrimitive("bool");
    const intType = typing.arena.internPrimitive("i32");
    expect(typeArgs).toEqual([boolType, intType]);
  });

  it("infers impl type parameters from receiver nominal arguments", () => {
    const ast = loadAst("method_impl_type_inference.voyd");
    const { symbolTable, hir, typing } = semanticsPipeline(ast);
    const root = symbolTable.rootScope;

    const unwrapSymbol = symbolTable.resolve("unwrap", root);
    expect(unwrapSymbol).toBeDefined();

    const unwrapCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") return false;
        const callee = hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" &&
          typeof unwrapSymbol === "number" &&
          callee.symbol === unwrapSymbol
        );
      }
    );
    expect(unwrapCall).toBeDefined();

    const typeArgs = typing.callTypeArguments.get(unwrapCall!.id);
    expect(typeArgs).toBeDefined();
    const intType = typing.arena.internPrimitive("i32");
    expect(typeArgs).toEqual([intType]);
  });
});
