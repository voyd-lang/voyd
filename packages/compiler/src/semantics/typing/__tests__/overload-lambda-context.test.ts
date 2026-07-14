import { describe, expect, it } from "vitest";
import type { HirCallExpr, HirLambdaExpr } from "../../hir/index.js";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("overload lambda context", () => {
  it("retypes lambda arguments after overload probing", () => {
    const semantics = semanticsPipeline(
      loadAst("overload_lambda_probe_retyping.voyd"),
    );
    const { hir, typing } = semantics;
    const i32 = typing.arena.internPrimitive("i32");

    const lambda = Array.from(hir.expressions.values()).find(
      (expr): expr is HirLambdaExpr => expr.exprKind === "lambda",
    );
    expect(lambda).toBeDefined();
    if (!lambda) return;

    const lambdaTypeId = typing.table.getExprType(lambda.id);
    expect(lambdaTypeId).toBeDefined();
    if (lambdaTypeId === undefined) return;

    const lambdaType = typing.arena.get(lambdaTypeId);
    expect(lambdaType.kind).toBe("function");
    if (lambdaType.kind !== "function") return;
    expect(lambdaType.parameters).toHaveLength(1);
    expect(lambdaType.parameters[0]?.type).toBe(i32);
    expect(lambdaType.returnType).toBe(i32);

    const call = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr =>
        expr.exprKind === "call" &&
        expr.args.some(
          (arg) => hir.expressions.get(arg.expr)?.exprKind === "lambda",
        ),
    );
    expect(call).toBeDefined();
    if (!call) return;
    expect(typing.table.getExprType(call.id)).toBe(i32);
  });

  it("prefers an exact lambda arity over contextual parameter omission", () => {
    const semantics = semanticsPipeline(
      loadAst("overload_lambda_exact_arity_preference.voyd"),
    );
    const { hir, typing } = semantics;

    const call = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr =>
        expr.exprKind === "call" &&
        expr.args.some(
          (arg) => hir.expressions.get(arg.expr)?.exprKind === "lambda",
        ),
    );
    expect(call).toBeDefined();
    if (!call) return;
    expect(typing.table.getExprType(call.id)).toBe(typing.primitives.bool);
  });

  it("prefers a return-compatible omitted-parameter candidate", () => {
    const semantics = semanticsPipeline(
      loadAst("overload_lambda_exact_arity_return_compatibility.voyd"),
    );
    const { hir, typing } = semantics;

    const call = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr =>
        expr.exprKind === "call" &&
        expr.args.some(
          (arg) => hir.expressions.get(arg.expr)?.exprKind === "lambda",
        ),
    );
    expect(call).toBeDefined();
    if (!call) return;
    expect(typing.table.getExprType(call.id)).toBe(typing.primitives.i32);
  });

  it("scores exact arity across multiple inline lambdas", () => {
    const semantics = semanticsPipeline(
      loadAst("overload_lambda_partial_exact_arity_preference.voyd"),
    );
    const { hir, typing } = semantics;

    const call = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr =>
        expr.exprKind === "call" &&
        expr.args.filter(
          (arg) => hir.expressions.get(arg.expr)?.exprKind === "lambda",
        ).length === 2,
    );
    expect(call).toBeDefined();
    if (!call) return;
    expect(typing.table.getExprType(call.id)).toBe(typing.primitives.bool);
  });
});
