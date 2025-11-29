import type {
  HirCallableOwner,
  HirCapture,
  HirExpression,
  HirFunction,
  HirGraph,
  HirLambdaExpr,
  HirMatchArm,
  HirObjectLiteralEntry,
  HirStatement,
} from "../hir/index.js";
import type { SymbolTable } from "../binder/index.js";
import type { NodeId, ScopeId, SymbolId } from "../ids.js";

export const analyzeLambdaCaptures = ({
  hir,
  symbolTable,
  scopeByNode,
}: {
  hir: HirGraph;
  symbolTable: SymbolTable;
  scopeByNode: Map<NodeId, ScopeId>;
}): void => {
  const lambdaScopeById = new Map<number, ScopeId>();
  const scopeOwners = new Map<ScopeId, HirCallableOwner>();

  const scopeCache = new Map<ScopeId, ReturnType<typeof symbolTable.getScope>>();
  const getScope = (id: ScopeId) => {
    const cached = scopeCache.get(id);
    if (cached) return cached;
    const scope = symbolTable.getScope(id);
    scopeCache.set(id, scope);
    return scope;
  };

  const functionByAst = new Map<NodeId, HirFunction>();
  hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    functionByAst.set(item.ast, item);
  });

  const lambdaByAst = new Map<NodeId, HirLambdaExpr>();
  hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "lambda") return;
    lambdaByAst.set(expr.ast, expr);
  });

  scopeByNode.forEach((scope, nodeId) => {
    const lambda = lambdaByAst.get(nodeId);
    if (lambda) {
      lambdaScopeById.set(lambda.id, scope);
      scopeOwners.set(scope, { kind: "lambda", expr: lambda.id });
      return;
    }

    const fn = functionByAst.get(nodeId);
    if (fn) {
      scopeOwners.set(scope, { kind: "function", item: fn.id, symbol: fn.symbol });
    }
  });

  const findOwner = (scope: ScopeId): HirCallableOwner | undefined => {
    let current = getScope(scope).parent;
    while (typeof current === "number") {
      const owner = scopeOwners.get(current);
      if (owner) return owner;
      current = getScope(current).parent;
    }
    return undefined;
  };

  const isWithinScope = (scope: ScopeId, ancestor: ScopeId): boolean => {
    let current: ScopeId | null = scope;
    while (current !== null) {
      if (current === ancestor) return true;
      current = getScope(current).parent;
    }
    return false;
  };

  const collectCaptures = (
    root: number,
    lambdaScope: ScopeId
  ): HirCapture[] => {
    const captures: HirCapture[] = [];
    const seen = new Set<SymbolId>();

    const visitIdentifier = (
      expr: HirExpression & { exprKind: "identifier"; symbol: SymbolId }
    ) => {
      const record = symbolTable.getSymbol(expr.symbol);
      const metadata = (record.metadata ?? {}) as { intrinsic?: boolean; mutable?: boolean };
      if (metadata.intrinsic) return;

      if (isWithinScope(record.scope, lambdaScope)) {
        return;
      }

      if (seen.has(expr.symbol)) {
        return;
      }
      seen.add(expr.symbol);
      captures.push({
        symbol: expr.symbol,
        span: expr.span,
        mutable: Boolean(metadata.mutable),
      });
    };

    walkExpression(root, hir, visitIdentifier);
    return captures;
  };

  hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "lambda") return;
    const lambdaScope = lambdaScopeById.get(expr.id);
    if (lambdaScope === undefined) {
      expr.captures = [];
      expr.owner = findOwner(scopeByNode.get(expr.ast) ?? symbolTable.rootScope);
      return;
    }
    expr.owner = findOwner(lambdaScope);
    expr.captures = collectCaptures(expr.body, lambdaScope);
  });
};

const walkExpression = (
  exprId: number,
  hir: HirGraph,
  onIdentifier: (expr: HirExpression & { exprKind: "identifier" }) => void
): void => {
  const expr = hir.expressions.get(exprId);
  if (!expr) {
    throw new Error(`missing HirExpression ${exprId}`);
  }

  switch (expr.exprKind) {
    case "identifier":
      onIdentifier(expr);
      return;
    case "literal":
    case "overload-set":
    case "continue":
      return;
    case "break":
      if (typeof expr.value === "number") {
        walkExpression(expr.value, hir, onIdentifier);
      }
      return;
    case "call":
      walkExpression(expr.callee, hir, onIdentifier);
      expr.args.forEach((arg) => walkExpression(arg.expr, hir, onIdentifier));
      return;
    case "block":
      expr.statements.forEach((stmt) =>
        walkStatement(stmt, hir, onIdentifier)
      );
      if (typeof expr.value === "number") {
        walkExpression(expr.value, hir, onIdentifier);
      }
      return;
    case "tuple":
      expr.elements.forEach((entry) =>
        walkExpression(entry, hir, onIdentifier)
      );
      return;
    case "loop":
      walkExpression(expr.body, hir, onIdentifier);
      return;
    case "while":
      walkExpression(expr.condition, hir, onIdentifier);
      walkExpression(expr.body, hir, onIdentifier);
      return;
    case "cond":
    case "if":
      expr.branches.forEach((branch) => {
        walkExpression(branch.condition, hir, onIdentifier);
        walkExpression(branch.value, hir, onIdentifier);
      });
      if (typeof expr.defaultBranch === "number") {
        walkExpression(expr.defaultBranch, hir, onIdentifier);
      }
      return;
    case "match":
      walkExpression(expr.discriminant, hir, onIdentifier);
      expr.arms.forEach((arm) => walkMatchArm(arm, hir, onIdentifier));
      return;
    case "effect-handler":
      walkExpression(expr.body, hir, onIdentifier);
      expr.handlers.forEach((handler) =>
        walkExpression(handler.body, hir, onIdentifier)
      );
      if (typeof expr.finallyBranch === "number") {
        walkExpression(expr.finallyBranch, hir, onIdentifier);
      }
      return;
    case "object-literal":
      expr.entries.forEach((entry) =>
        walkObjectLiteralEntry(entry, hir, onIdentifier)
      );
      return;
    case "field-access":
      walkExpression(expr.target, hir, onIdentifier);
      return;
    case "assign":
      if (typeof expr.target === "number") {
        walkExpression(expr.target, hir, onIdentifier);
      }
      walkExpression(expr.value, hir, onIdentifier);
      return;
    case "lambda":
      return;
  }
};

const walkStatement = (
  stmtId: number,
  hir: HirGraph,
  onIdentifier: (expr: HirExpression & { exprKind: "identifier" }) => void
): void => {
  const stmt = hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`missing HirStatement ${stmtId}`);
  }

  switch (stmt.kind) {
    case "let":
      walkExpression(stmt.initializer, hir, onIdentifier);
      return;
    case "expr-stmt":
      walkExpression(stmt.expr, hir, onIdentifier);
      return;
    case "return":
      if (typeof stmt.value === "number") {
        walkExpression(stmt.value, hir, onIdentifier);
      }
      return;
  }
};

const walkMatchArm = (
  arm: HirMatchArm,
  hir: HirGraph,
  onIdentifier: (expr: HirExpression & { exprKind: "identifier" }) => void
): void => {
  if (typeof arm.guard === "number") {
    walkExpression(arm.guard, hir, onIdentifier);
  }
  walkExpression(arm.value, hir, onIdentifier);
};

const walkObjectLiteralEntry = (
  entry: HirObjectLiteralEntry,
  hir: HirGraph,
  onIdentifier: (expr: HirExpression & { exprKind: "identifier" }) => void
): void => {
  if (entry.kind === "spread") {
    walkExpression(entry.value, hir, onIdentifier);
    return;
  }
  walkExpression(entry.value, hir, onIdentifier);
};
