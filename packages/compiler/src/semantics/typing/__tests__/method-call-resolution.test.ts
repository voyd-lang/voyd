import { describe, expect, it } from "vitest";
import type { HirMethodCallExpr } from "../../hir/nodes.js";
import { semanticsPipeline } from "../../pipeline.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { parse } from "../../../parser/index.js";

describe("method call resolution", () => {
  it("falls back to free functions when a same-named method does not match", () => {
    const semantics = semanticsPipeline(
      loadAst("method_call_method_name_collision.voyd"),
    );
    expect(semantics.diagnostics).toHaveLength(0);

    const methodCall = Array.from(semantics.hir.expressions.values()).find(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" && expr.method === "reduce",
    );
    expect(methodCall).toBeDefined();
    if (!methodCall) return;

    const symbolTable = getSymbolTable(semantics);
    const rootScope = symbolTable.rootScope;

    const mainSymbol = symbolTable.resolve("main", rootScope);
    const reduceSymbol = symbolTable.resolve("reduce", rootScope);
    expect(typeof mainSymbol).toBe("number");
    expect(typeof reduceSymbol).toBe("number");
    if (typeof mainSymbol !== "number" || typeof reduceSymbol !== "number") {
      return;
    }

    const instanceKey = `${mainSymbol}<>`;
    const target = semantics.typing.callTargets.get(methodCall.id)?.get(instanceKey);
    expect(target?.symbol).toBe(reduceSymbol);
  });

  it("indexes uninstantiated generic calls without specializing them", () => {
    const semantics = semanticsPipeline(
      parse(
        `
obj Box<T> { value: T }

impl<T> Box<T>
  fn update(~self, value: T) -> void
    self.value = value

  fn relay(~self, value: T) -> void
    self.update(value)

pub fn main() -> void
  void
`,
        "generic_borrow_call_resolution.voyd",
      ),
    );
    const methodCall = Array.from(
      semantics.hir.expressions.values(),
    ).find(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" && expr.method === "update",
    );
    expect(methodCall).toBeDefined();
    if (!methodCall) return;

    const symbols = getSymbolTable(semantics);
    const updateItem = Array.from(semantics.hir.items.values()).find(
      (item): item is Extract<typeof item, { kind: "function" }> =>
        item.kind === "function" &&
        symbols.getSymbol(item.symbol).name === "update",
    );
    const update = updateItem?.symbol;
    expect(typeof update).toBe("number");
    expect(semantics.typing.callTargets.has(methodCall.id)).toBe(false);
    expect(
      Array.from(
        semantics.typing.borrowCallTargets
          .get(methodCall.id)
          ?.values() ?? [],
      ).some((target) => target.symbol === update),
    ).toBe(true);
  });
});
