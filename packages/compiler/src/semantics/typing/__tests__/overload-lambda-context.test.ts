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

    const zeroParameterLambdas = Array.from(hir.expressions.values()).filter(
      (expr): expr is HirLambdaExpr =>
        expr.exprKind === "lambda" && expr.parameters.length === 0,
    );
    const contextualParameterCounts = zeroParameterLambdas
      .map((lambda) => typing.table.getExprType(lambda.id))
      .filter((typeId): typeId is number => typeId !== undefined)
      .map((typeId) => typing.arena.get(typeId))
      .filter((type) => type.kind === "function")
      .map((type) => type.parameters.length)
      .sort();
    expect(contextualParameterCounts).toEqual([0, 1]);
  });
});
