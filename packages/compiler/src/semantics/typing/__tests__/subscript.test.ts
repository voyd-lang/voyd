import { describe, expect, it } from "vitest";
import type { HirMethodCallExpr } from "../../hir/nodes.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";

describe("subscript typing", () => {
  it("resolves subscript reads and writes through trait methods", () => {
    const semantics = semanticsPipeline(loadAst("subscript.voyd"));
    const { hir, typing } = semantics;

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

    const indexRead = methodCalls.find((call) => {
      if (call.method !== "subscript_get") return false;
      const arg = call.args[0];
      if (!arg) return false;
      return hir.expressions.get(arg.expr)?.exprKind !== "object-literal";
    });
    expect(indexRead).toBeDefined();
    if (!indexRead) return;

    const readType = typing.table.getExprType(indexRead.id);
    expect(typeof readType).toBe("number");
    if (typeof readType !== "number") return;
    const readDesc = typing.arena.get(readType);
    expect(readDesc.kind).toBe("primitive");
    if (readDesc.kind === "primitive") {
      expect(readDesc.name).toBe("i32");
    }

    const writeCall = methodCalls.find((call) => call.method === "subscript_set");
    expect(writeCall).toBeDefined();
    if (!writeCall) return;
    const writeType = typing.table.getExprType(writeCall.id);
    expect(writeType).toBe(typing.primitives.void);
  });

  it("reports missing subscript trait implementations", () => {
    expect(() =>
      semanticsPipeline(loadAst("subscript_missing_impl.voyd"))
    ).toThrow(/subscript_get/);
  });
});
