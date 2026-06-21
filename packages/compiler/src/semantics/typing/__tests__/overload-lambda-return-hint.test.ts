import { describe, expect, it } from "vitest";
import type {
  HirCallExpr,
  HirLambdaExpr,
  HirMethodCallExpr,
} from "../../hir/index.js";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("overload lambda return hint", () => {
  it("uses expected return type hints to type lambda arguments", () => {
    const semantics = semanticsPipeline(
      loadAst("overload_lambda_expected_return_hint.voyd"),
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

  it("applies explicit type arguments to narrowed overload lambda hints", () => {
    const semantics = semanticsPipeline(
      loadAst("overload_lambda_explicit_type_args_return_hint.voyd"),
    );
    const { hir, typing } = semantics;
    const bool = typing.arena.internPrimitive("bool");

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
    expect(lambdaType.parameters[0]?.type).toBe(bool);
    expect(lambdaType.returnType).toBe(bool);

    const call = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr =>
        expr.exprKind === "call" &&
        (expr.typeArguments?.length ?? 0) > 0 &&
        expr.args.some(
          (arg) => hir.expressions.get(arg.expr)?.exprKind === "lambda",
        ),
    );
    expect(call).toBeDefined();
    if (!call) return;
    expect(typing.table.getExprType(call.id)).toBe(bool);
  });

  it("uses callback return types to disambiguate overloads before generic constraints", () => {
    expect(() =>
      semanticsPipeline(
        loadAst("overload_lambda_callback_return_disambiguation.voyd"),
      ),
    ).not.toThrow();
  });

  it("uses named callback return types to reject incompatible generic overloads", () => {
    expect(() =>
      semanticsPipeline(
        loadAst("overload_named_callback_return_disambiguation.voyd"),
      ),
    ).not.toThrow();
  });

  it("uses callback return types to disambiguate method overloads", () => {
    const semantics = semanticsPipeline(
      loadAst("overload_lambda_method_return_disambiguation.voyd"),
    );
    const { hir, typing } = semantics;
    const bool = typing.arena.internPrimitive("bool");

    const call = Array.from(hir.expressions.values()).find(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" && expr.method === "get",
    );
    expect(call).toBeDefined();
    if (!call) return;

    const targets = typing.callTargets.get(call.id);
    const target = targets?.values().next().value;
    expect(target).toBeDefined();
    if (!target) return;
    const signature = typing.functions.getSignature(target.symbol);
    expect(signature).toBeDefined();
    const handlerParam = signature?.parameters[2];
    expect(handlerParam).toBeDefined();
    if (!handlerParam) return;
    const handlerType = typing.arena.get(handlerParam.type);
    expect(handlerType.kind).toBe("function");
    if (handlerType.kind !== "function") return;
    expect(handlerType.returnType).toBe(bool);
  });

  it("applies target type arguments to expected return overload hints", () => {
    const semantics = semanticsPipeline(
      loadAst("static_overload_expected_return_target_args.voyd"),
    );
    const { hir, typing } = semantics;
    const i32 = typing.arena.internPrimitive("i32");

    const calls = Array.from(hir.expressions.values()).filter(
      (expr): expr is HirCallExpr => expr.exprKind === "call",
    );
    const produceCall = calls.find(
      (call) => (call.targetTypeArguments?.length ?? 0) > 0,
    );
    expect(produceCall).toBeDefined();
    if (!produceCall) return;
    expect(typing.table.getExprType(produceCall.id)).toBe(i32);
  });

  it("uses inline lambda parameter shape to disambiguate method overloads", () => {
    const semantics = semanticsPipeline(
      loadAst("overload_lambda_method_parameter_shape_disambiguation.voyd"),
    );
    const { hir, typing } = semantics;

    const calls = Array.from(hir.expressions.values())
      .filter(
        (expr): expr is HirMethodCallExpr =>
          expr.exprKind === "method-call" && expr.method === "get",
      )
      .sort((left, right) => (left.span?.start ?? 0) - (right.span?.start ?? 0));

    expect(calls).toHaveLength(3);
    const selectedTypeParamCounts = calls.map((call) => {
      const targets = typing.callTargets.get(call.id);
      const target = targets?.values().next().value;
      expect(target).toBeDefined();
      if (!target) return undefined;
      return typing.functions.getSignature(target.symbol)?.typeParams?.length ?? 0;
    });

    expect(selectedTypeParamCounts).toEqual([1, 2, 3]);
  });
});
