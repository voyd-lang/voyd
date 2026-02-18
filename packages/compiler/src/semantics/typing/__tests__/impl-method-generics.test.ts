import { describe, expect, it } from "vitest";
import type { HirMethodCallExpr } from "../../hir/nodes.js";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("impl method generics", () => {
  it("binds explicit type arguments to method generics before impl generics", () => {
    const ast = loadAst("impl_method_generics.voyd");
    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;

    const pickCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" && expr.method === "pick"
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

    const typeArgsByInstance = typing.callTypeArguments.get(pickCall!.id);
    const typeArgs = typeArgsByInstance
      ? Array.from(typeArgsByInstance.values())[0]
      : undefined;
    expect(typeArgs).toBeDefined();
    const boolType = typing.arena.internPrimitive("bool");
    const intType = typing.arena.internPrimitive("i32");
    expect(typeArgs).toEqual([boolType, intType]);
  });

  it("infers impl type parameters from receiver nominal arguments", () => {
    const ast = loadAst("method_impl_type_inference.voyd");
    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;

    const unwrapCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" && expr.method === "unwrap"
    );
    expect(unwrapCall).toBeDefined();

    const typeArgsByInstance = typing.callTypeArguments.get(unwrapCall!.id);
    const typeArgs = typeArgsByInstance
      ? Array.from(typeArgsByInstance.values())[0]
      : undefined;
    expect(typeArgs).toBeDefined();
    const intType = typing.arena.internPrimitive("i32");
    expect(typeArgs).toEqual([intType]);
  });
});
