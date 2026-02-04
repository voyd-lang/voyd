import { describe, expect, it } from "vitest";
import type { HirLambdaExpr } from "../../hir/index.js";
import type { HirMethodCallExpr } from "../../hir/nodes.js";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("method call lambda inference", () => {
  it("infers lambda types from method signature context", () => {
    const semantics = semanticsPipeline(
      loadAst("method_call_lambda_context_inference.voyd"),
    );
    const { hir, typing } = semantics;

    const mapCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" && expr.method === "map",
    );
    expect(mapCall).toBeDefined();
    if (!mapCall) return;

    const typeArgsByInstance = typing.callTypeArguments.get(mapCall.id);
    const typeArgs = typeArgsByInstance
      ? Array.from(typeArgsByInstance.values())[0]
      : undefined;
    expect(typeArgs).toBeDefined();
    expect(typeArgs).toHaveLength(2);
    expect(typeArgs).not.toContain(typing.primitives.unknown);

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
    expect(lambdaType.parameters[0]?.type).not.toBe(typing.primitives.unknown);
    expect(lambdaType.returnType).not.toBe(typing.primitives.unknown);
  });
});

