import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";
import type { HirCallExpr, HirFunction } from "../../hir/nodes.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";

describe("unions", () => {
  it("allows assigning narrower unions to wider unions", () => {
    const ast = loadAst("unions_widening.voyd");
    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);

    const rootScope = symbolTable.rootScope;
    const acceptSymbol = symbolTable.resolve("accept", rootScope);
    const callerSymbol = symbolTable.resolve("call_with_narrow", rootScope);
    expect(acceptSymbol).toBeDefined();
    expect(callerSymbol).toBeDefined();
    if (typeof acceptSymbol !== "number" || typeof callerSymbol !== "number") {
      return;
    }

    const callerFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === callerSymbol
    );
    expect(callerFn).toBeDefined();
    const callerParam = callerFn?.parameters[0];
    expect(callerParam).toBeDefined();
    const callerParamType =
      callerParam && typing.valueTypes.get(callerParam.symbol);
    expect(callerParamType).toBeDefined();
    if (typeof callerParamType !== "number") {
      return;
    }
    const callerParamDesc = typing.arena.get(callerParamType);
    expect(callerParamDesc).toMatchObject({ kind: "union" });
    if (callerParamDesc.kind === "union") {
      expect(callerParamDesc.members.length).toBe(2);
    }

    const acceptFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === acceptSymbol
    );
    expect(acceptFn).toBeDefined();
    const acceptParam = acceptFn?.parameters[0];
    expect(acceptParam).toBeDefined();
    const acceptParamType =
      acceptParam && typing.valueTypes.get(acceptParam.symbol);
    expect(acceptParamType).toBeDefined();
    if (typeof acceptParamType !== "number") {
      return;
    }
    const acceptParamDesc = typing.arena.get(acceptParamType);
    expect(acceptParamDesc).toMatchObject({ kind: "union" });
    if (acceptParamDesc.kind === "union") {
      expect(acceptParamDesc.members.length).toBe(3);
    }

    const callExpr = Array.from(hir.expressions.values()).find(
      (candidate): candidate is HirCallExpr => {
        if (candidate.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(candidate.callee);
        return (
          callee?.exprKind === "identifier" && callee.symbol === acceptSymbol
        );
      }
    );
    expect(callExpr).toBeDefined();
    if (!callExpr) {
      return;
    }
    const callType = typing.table.getExprType(callExpr.id);
    expect(callType).toBeDefined();
    if (typeof callType !== "number") {
      return;
    }

    expect(typing.arena.get(callType)).toMatchObject({
      kind: "primitive",
      name: "i32",
    });
  });
});
