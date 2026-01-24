import { walkExpression } from "../hir/index.js";
import type {
  HirCallableOwner,
  HirCapture,
  HirExpression,
  HirFunction,
  HirGraph,
  HirLambdaExpr,
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
  const lambdaById = new Map<number, HirLambdaExpr>();

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
    lambdaById.set(expr.id, expr);
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
      const metadata = (record.metadata ?? {}) as {
        intrinsic?: boolean;
        mutable?: boolean;
        import?: unknown;
      };
      if (metadata.intrinsic) return;
      if (metadata.import) return;
      if (record.scope === symbolTable.rootScope) {
        return;
      }
      const scopeKind = getScope(record.scope).kind;
      const captureAllowed =
        scopeKind === "function" || scopeKind === "lambda" || scopeKind === "block";
      if (!captureAllowed) {
        return;
      }

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

    walkExpression({
      exprId: root,
      hir,
      options: { skipLambdas: true },
      onEnterExpression: (_exprId, expr) => {
        if (expr.exprKind === "identifier") {
          visitIdentifier(expr);
        }
      },
    });
    return captures;
  };

  const baseCaptures = new Map<number, HirCapture[]>();

  hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "lambda") return;
    const lambdaScope = lambdaScopeById.get(expr.id);
    if (lambdaScope === undefined) {
      expr.owner = findOwner(scopeByNode.get(expr.ast) ?? symbolTable.rootScope);
      baseCaptures.set(expr.id, []);
      return;
    }
    expr.owner = findOwner(lambdaScope);
    baseCaptures.set(expr.id, collectCaptures(expr.body, lambdaScope));
  });

  hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "lambda") return;
    const lambdaScope = lambdaScopeById.get(expr.id);
    const captures = [...(baseCaptures.get(expr.id) ?? [])];
    if (lambdaScope === undefined) {
      expr.captures = captures;
      return;
    }

    const nested = new Set<number>();
    gatherNestedLambdas(expr.body, hir, nested);
    nested.forEach((nestedId) => {
      const nestedLambda = lambdaById.get(nestedId);
      if (!nestedLambda?.captures) return;
      nestedLambda.captures.forEach((capture) => {
        const symbolScope = symbolTable.getSymbol(capture.symbol).scope;
        if (isWithinScope(symbolScope, lambdaScope)) return;
        if (captures.some((existing) => existing.symbol === capture.symbol)) {
          return;
        }
        captures.push(capture);
      });
    });
    expr.captures = captures;
  });
};

const gatherNestedLambdas = (
  exprId: number,
  hir: HirGraph,
  nested: Set<number>
): void => {
  walkExpression({
    exprId,
    hir,
    onEnterExpression: (_exprId, expr) => {
      if (expr.exprKind === "lambda") {
        nested.add(expr.id);
      }
    },
  });
};
