import type {
  HirExpression,
  HirGraph,
  HirIdentifierExpr,
} from "../hir/index.js";
import type { HirExprId } from "../ids.js";
import type { SymbolId } from "../ids.js";
import type { TypingResult } from "./typing.js";
import { symbolRefKey } from "./symbol-ref.js";

export const specializeOverloadCallees = ({
  hir,
  typing,
  moduleId,
  imports,
}: {
  hir: HirGraph;
  typing: TypingResult;
  moduleId: string;
  imports: readonly {
    local: SymbolId;
    target?: { moduleId: string; symbol: SymbolId };
  }[];
}): void => {
  const expressions = hir.expressions as Map<HirExprId, HirExpression>;
  const unspecialized = new Set<HirExprId>();
  const importTargets = new Map<string, SymbolId>();
  imports.forEach((entry) => {
    if (!entry.target) return;
    importTargets.set(symbolRefKey(entry.target), entry.local);
  });

  const resolveLocalSymbol = (ref: { moduleId: string; symbol: SymbolId }): SymbolId | undefined =>
    ref.moduleId === moduleId ? ref.symbol : importTargets.get(symbolRefKey(ref));

  for (const expr of expressions.values()) {
    if (expr.exprKind !== "call") continue;
    const callee = expressions.get(expr.callee);
    if (!callee || callee.exprKind !== "overload-set") {
      continue;
    }

    const targets = typing.callTargets.get(expr.id);
    if (!targets || targets.size === 0) {
      throw new Error(
        `missing overload resolution for call expression ${expr.id}`
      );
    }

    const uniqueTargets = new Map<string, { moduleId: string; symbol: SymbolId }>();
    targets.forEach((target) => {
      uniqueTargets.set(symbolRefKey(target), target);
    });
    if (uniqueTargets.size > 1) {
      unspecialized.add(callee.id);
      continue;
    }

    const [target] = Array.from(uniqueTargets.values());
    if (!target) {
      throw new Error(
        `missing overload resolution for call expression ${expr.id}`
      );
    }
    const localSymbol = resolveLocalSymbol(target);
    if (typeof localSymbol !== "number") {
      unspecialized.add(callee.id);
      continue;
    }

    const replacement: HirIdentifierExpr = {
      kind: "expr",
      exprKind: "identifier",
      id: callee.id,
      ast: callee.ast,
      span: callee.span,
      typeHint: callee.typeHint,
      symbol: localSymbol,
    };

    expressions.set(callee.id, replacement);
  }

  const remaining = Array.from(expressions.values()).find(
    (expr) => expr.exprKind === "overload-set" && !unspecialized.has(expr.id)
  );
  if (remaining) {
    throw new Error(
      `overload set ${remaining.id} was not eliminated during specialization`
    );
  }
};
