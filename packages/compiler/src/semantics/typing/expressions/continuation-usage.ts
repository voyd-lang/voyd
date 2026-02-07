import { walkExpression, type HirGraph } from "../../hir/index.js";
import type { HirExprId, SymbolId } from "../../ids.js";

export type ContinuationUsage = { min: number; max: number; escapes: boolean };

type UsageRange = { min: number; max: number };

type ContinuationFlowUsage = {
  fallthrough?: UsageRange;
  terminal?: UsageRange;
  escapes: boolean;
};

export function analyzeContinuationUsage({
  exprId,
  targetSymbol,
  hir,
  nested,
}: {
  exprId: HirExprId;
  targetSymbol: SymbolId;
  hir: HirGraph;
  nested?: boolean;
}): ContinuationUsage {
  const emptyUsage: ContinuationFlowUsage = {
    fallthrough: zeroRange(),
    escapes: false,
  };
  const usageByExpr = new Map<number, ContinuationFlowUsage>();
  const usageByStmt = new Map<number, ContinuationFlowUsage>();
  const usageForExpr = (id?: number): ContinuationFlowUsage =>
    typeof id === "number" ? (usageByExpr.get(id) ?? emptyUsage) : emptyUsage;
  const usageForStmt = (id: number): ContinuationFlowUsage =>
    usageByStmt.get(id) ?? emptyUsage;

  let nestedLambdaDepth = nested ? 1 : 0;

  walkExpression({
    exprId,
    hir,
    onEnterExpression: (_id, expr) => {
      if (expr.exprKind === "lambda") {
        nestedLambdaDepth += 1;
      }
    },
    onExitStatement: (stmtId, stmt) => {
      const usage = (() => {
        switch (stmt.kind) {
          case "let":
            return usageForExpr(stmt.initializer);
          case "expr-stmt":
            return usageForExpr(stmt.expr);
          case "return":
            return terminateUsage({
              usage:
                typeof stmt.value === "number"
                  ? usageForExpr(stmt.value)
                  : emptyUsage,
            });
        }
      })();
      usageByStmt.set(stmtId, usage);
    },
    onExitExpression: (id, expr) => {
      let usage = emptyUsage;
      switch (expr.exprKind) {
        case "identifier":
          usage =
            expr.symbol === targetSymbol
              ? { fallthrough: zeroRange(), escapes: true }
              : emptyUsage;
          break;
        case "literal":
        case "overload-set":
        case "continue":
          usage = emptyUsage;
          break;
        case "break":
          usage =
            typeof expr.value === "number"
              ? usageForExpr(expr.value)
              : emptyUsage;
          break;
        case "call": {
          const callee = hir.expressions.get(expr.callee);
          const argsUsage = expr.args.reduce(
            (acc, arg) => sequenceUsage({ left: acc, right: usageForExpr(arg.expr) }),
            emptyUsage,
          );
          usage =
            callee?.exprKind === "identifier" && callee.symbol === targetSymbol
              ? sequenceUsage({
                  left: argsUsage,
                  right: {
                    terminal: { min: 1, max: 1 },
                    escapes: nestedLambdaDepth > 0,
                  },
                })
              : expr.args.reduce(
                  (acc, arg) =>
                    sequenceUsage({ left: acc, right: usageForExpr(arg.expr) }),
                  usageForExpr(expr.callee),
                );
          break;
        }
        case "block":
          usage = expr.statements.reduce(
            (acc, stmtId) => sequenceUsage({ left: acc, right: usageForStmt(stmtId) }),
            emptyUsage,
          );
          if (typeof expr.value === "number") {
            usage = sequenceUsage({ left: usage, right: usageForExpr(expr.value) });
          }
          break;
        case "tuple":
          usage = expr.elements.reduce(
            (acc, entry) => sequenceUsage({ left: acc, right: usageForExpr(entry) }),
            emptyUsage,
          );
          break;
        case "loop":
          usage = toLoopUsage({ usage: usageForExpr(expr.body) });
          break;
        case "while":
          usage = sequenceUsage({
            left: usageForExpr(expr.condition),
            right: toLoopUsage({ usage: usageForExpr(expr.body) }),
          });
          break;
        case "cond":
        case "if": {
          const branchUsages = expr.branches.map((branch) =>
            sequenceUsage({
              left: usageForExpr(branch.condition),
              right: usageForExpr(branch.value),
            }),
          );
          const defaultUsage =
            typeof expr.defaultBranch === "number"
              ? usageForExpr(expr.defaultBranch)
              : emptyUsage;
          usage = mergeBranches({ branches: [...branchUsages, defaultUsage] });
          break;
        }
        case "match": {
          const discriminantUsage = usageForExpr(expr.discriminant);
          const armUsages = expr.arms.map((arm) => {
            const guardUsage =
              typeof arm.guard === "number"
                ? usageForExpr(arm.guard)
                : emptyUsage;
            return sequenceUsage({ left: guardUsage, right: usageForExpr(arm.value) });
          });
          usage = sequenceUsage({
            left: discriminantUsage,
            right: mergeBranches({ branches: armUsages }),
          });
          break;
        }
        case "effect-handler": {
          usage = usageForExpr(expr.body);
          expr.handlers.forEach((handler) => {
            usage = sequenceUsage({ left: usage, right: usageForExpr(handler.body) });
          });
          if (typeof expr.finallyBranch === "number") {
            usage = sequenceUsage({ left: usage, right: usageForExpr(expr.finallyBranch) });
          }
          break;
        }
        case "object-literal":
          usage = expr.entries.reduce(
            (acc, entry) => sequenceUsage({ left: acc, right: usageForExpr(entry.value) }),
            emptyUsage,
          );
          break;
        case "field-access":
          usage = usageForExpr(expr.target);
          break;
        case "assign": {
          const targetUsage =
            typeof expr.target === "number"
              ? usageForExpr(expr.target)
              : emptyUsage;
          usage = sequenceUsage({ left: targetUsage, right: usageForExpr(expr.value) });
          break;
        }
        case "lambda": {
          const inner = summarizeUsage({ usage: usageForExpr(expr.body) });
          usage =
            inner.min > 0 || inner.max > 0 || inner.escapes
              ? {
                  fallthrough: { min: inner.min, max: inner.max },
                  escapes: true,
                }
              : emptyUsage;
          nestedLambdaDepth -= 1;
          break;
        }
      }
      usageByExpr.set(id, usage);
    },
  });

  return summarizeUsage({ usage: usageByExpr.get(exprId) ?? emptyUsage });
}

function zeroRange(): UsageRange {
  return { min: 0, max: 0 };
}

function addRanges({
  left,
  right,
}: {
  left: UsageRange;
  right: UsageRange;
}): UsageRange {
  return {
    min: left.min + right.min,
    max: left.max + right.max,
  };
}

function unionRanges({
  left,
  right,
}: {
  left?: UsageRange;
  right?: UsageRange;
}): UsageRange | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    min: Math.min(left.min, right.min),
    max: Math.max(left.max, right.max),
  };
}

function unionRangeList({
  ranges,
}: {
  ranges: Array<UsageRange | undefined>;
}): UsageRange | undefined {
  return ranges.reduce<UsageRange | undefined>(
    (acc, range) => unionRanges({ left: acc, right: range }),
    undefined,
  );
}

function summarizeUsage({
  usage,
}: {
  usage: ContinuationFlowUsage;
}): ContinuationUsage {
  const total = unionRanges({
    left: usage.fallthrough,
    right: usage.terminal,
  });
  if (!total) {
    return { min: 0, max: 0, escapes: usage.escapes };
  }
  return { min: total.min, max: total.max, escapes: usage.escapes };
}

function sequenceUsage({
  left,
  right,
}: {
  left: ContinuationFlowUsage;
  right: ContinuationFlowUsage;
}): ContinuationFlowUsage {
  const canContinue = !!left.fallthrough;
  const terminalFromRight =
    left.fallthrough && right.terminal
      ? addRanges({ left: left.fallthrough, right: right.terminal })
      : undefined;
  return {
    fallthrough:
      left.fallthrough && right.fallthrough
        ? addRanges({ left: left.fallthrough, right: right.fallthrough })
        : undefined,
    terminal: unionRanges({ left: left.terminal, right: terminalFromRight }),
    escapes: left.escapes || (canContinue ? right.escapes : false),
  };
}

function mergeBranches({
  branches,
}: {
  branches: ContinuationFlowUsage[];
}): ContinuationFlowUsage {
  if (branches.length === 0) {
    return { fallthrough: zeroRange(), escapes: false };
  }
  return {
    fallthrough: unionRangeList({
      ranges: branches.map((branch) => branch.fallthrough),
    }),
    terminal: unionRangeList({
      ranges: branches.map((branch) => branch.terminal),
    }),
    escapes: branches.some((branch) => branch.escapes),
  };
}

function toLoopUsage({
  usage,
}: {
  usage: ContinuationFlowUsage;
}): ContinuationFlowUsage {
  const summarized = summarizeUsage({ usage });
  return {
    fallthrough: {
      min: 0,
      max: summarized.max > 0 ? Number.POSITIVE_INFINITY : 0,
    },
    escapes: usage.escapes,
  };
}

function terminateUsage({
  usage,
}: {
  usage: ContinuationFlowUsage;
}): ContinuationFlowUsage {
  return {
    terminal: unionRanges({ left: usage.terminal, right: usage.fallthrough }),
    escapes: usage.escapes,
  };
}
