import type { HirExprId, HirStmtId } from "../ids.js";
import type { HirGraph } from "./builder.js";
import type { HirExpression, HirPattern, HirStatement } from "./nodes.js";

export type WalkOptions = {
  skipEffectHandlers?: boolean;
  skipLambdas?: boolean;
  visitHandlerBodies?: boolean;
  visitPatterns?: boolean;
};

export type WalkControl = {
  skipChildren?: boolean;
  stop?: boolean;
};

const walkPatternInternal = ({
  pattern,
  onEnterPattern,
  onExitPattern,
}: {
  pattern: HirPattern;
  onEnterPattern?: (pattern: HirPattern) => WalkControl | void;
  onExitPattern?: (pattern: HirPattern) => void;
}): boolean => {
  const control = onEnterPattern?.(pattern);
  if (control?.stop) {
    return true;
  }

  if (!control?.skipChildren) {
    switch (pattern.kind) {
      case "identifier":
      case "wildcard":
        break;
      case "destructure":
        for (const field of pattern.fields) {
          if (
            walkPatternInternal({
              pattern: field.pattern,
              onEnterPattern,
              onExitPattern,
            })
          ) {
            return true;
          }
        }
        if (
          pattern.spread &&
          walkPatternInternal({ pattern: pattern.spread, onEnterPattern, onExitPattern })
        ) {
          return true;
        }
        break;
      case "tuple":
        for (const element of pattern.elements) {
          if (
            walkPatternInternal({
              pattern: element,
              onEnterPattern,
              onExitPattern,
            })
          ) {
            return true;
          }
        }
        break;
      case "type":
        if (
          pattern.binding &&
          walkPatternInternal({ pattern: pattern.binding, onEnterPattern, onExitPattern })
        ) {
          return true;
        }
        break;
    }
  }

  onExitPattern?.(pattern);
  return false;
};

export const walkPattern = ({
  pattern,
  onEnterPattern,
  onExitPattern,
}: {
  pattern: HirPattern;
  onEnterPattern?: (pattern: HirPattern) => WalkControl | void;
  onExitPattern?: (pattern: HirPattern) => void;
}): void => {
  walkPatternInternal({ pattern, onEnterPattern, onExitPattern });
};

export const walkExpression = ({
  exprId,
  hir,
  onEnterExpression,
  onExitExpression,
  onEnterStatement,
  onExitStatement,
  onEnterPattern,
  onExitPattern,
  options,
}: {
  exprId: HirExprId;
  hir: HirGraph;
  onEnterExpression?: (exprId: HirExprId, expr: HirExpression) => WalkControl | void;
  onExitExpression?: (exprId: HirExprId, expr: HirExpression) => void;
  onEnterStatement?: (stmtId: HirStmtId, stmt: HirStatement) => WalkControl | void;
  onExitStatement?: (stmtId: HirStmtId, stmt: HirStatement) => void;
  onEnterPattern?: (pattern: HirPattern) => WalkControl | void;
  onExitPattern?: (pattern: HirPattern) => void;
  options?: WalkOptions;
}): void => {
  const shouldVisitPatterns =
    options?.visitPatterns === true || onEnterPattern !== undefined || onExitPattern !== undefined;
  const visitHandlerBodies = options?.visitHandlerBodies !== false;

  const visitPattern = (pattern: HirPattern): boolean =>
    walkPatternInternal({ pattern, onEnterPattern, onExitPattern });

  const visitExpression = (id: HirExprId): boolean => {
    const expr = hir.expressions.get(id);
    if (!expr) {
      throw new Error(`missing HirExpression ${id}`);
    }
    const control = onEnterExpression?.(id, expr);
    if (control?.stop) {
      return true;
    }

    const skipChildren =
      control?.skipChildren === true ||
      (options?.skipLambdas === true && expr.exprKind === "lambda") ||
      (options?.skipEffectHandlers === true && expr.exprKind === "effect-handler");

    if (!skipChildren) {
      switch (expr.exprKind) {
        case "literal":
        case "identifier":
        case "overload-set":
        case "continue":
          break;
        case "break":
          if (typeof expr.value === "number") {
            if (visitExpression(expr.value)) return true;
          }
          break;
        case "lambda":
          if (visitExpression(expr.body)) return true;
          break;
        case "effect-handler":
          if (visitExpression(expr.body)) return true;
          if (visitHandlerBodies) {
            for (const handler of expr.handlers) {
              if (visitExpression(handler.body)) return true;
            }
          }
          if (typeof expr.finallyBranch === "number") {
            if (visitExpression(expr.finallyBranch)) return true;
          }
          break;
        case "block":
          for (const stmtId of expr.statements) {
            if (visitStatement(stmtId)) return true;
          }
          if (typeof expr.value === "number") {
            if (visitExpression(expr.value)) return true;
          }
          break;
        case "call":
          if (visitExpression(expr.callee)) return true;
          for (const arg of expr.args) {
            if (visitExpression(arg.expr)) return true;
          }
          break;
        case "method-call":
          if (visitExpression(expr.target)) return true;
          for (const arg of expr.args) {
            if (visitExpression(arg.expr)) return true;
          }
          break;
        case "tuple":
          for (const entry of expr.elements) {
            if (visitExpression(entry)) return true;
          }
          break;
        case "loop":
          if (visitExpression(expr.body)) return true;
          break;
        case "while":
          if (visitExpression(expr.condition)) return true;
          if (visitExpression(expr.body)) return true;
          break;
        case "cond":
        case "if":
          for (const branch of expr.branches) {
            if (visitExpression(branch.condition)) return true;
            if (visitExpression(branch.value)) return true;
          }
          if (typeof expr.defaultBranch === "number") {
            if (visitExpression(expr.defaultBranch)) return true;
          }
          break;
        case "match":
          if (visitExpression(expr.discriminant)) return true;
          for (const arm of expr.arms) {
            if (typeof arm.guard === "number") {
              if (visitExpression(arm.guard)) return true;
            }
            if (visitExpression(arm.value)) return true;
          }
          break;
        case "object-literal":
          for (const entry of expr.entries) {
            if (visitExpression(entry.value)) return true;
          }
          break;
        case "field-access":
          if (visitExpression(expr.target)) return true;
          break;
        case "assign":
          if (typeof expr.target === "number") {
            if (visitExpression(expr.target)) return true;
          }
          if (visitExpression(expr.value)) return true;
          if (expr.pattern && shouldVisitPatterns) {
            if (visitPattern(expr.pattern)) return true;
          }
          break;
      }
    }

    onExitExpression?.(id, expr);
    return false;
  };

  const visitStatement = (id: HirStmtId): boolean => {
    const stmt = hir.statements.get(id);
    if (!stmt) {
      throw new Error(`missing HirStatement ${id}`);
    }
    const control = onEnterStatement?.(id, stmt);
    if (control?.stop) {
      return true;
    }

    if (!control?.skipChildren) {
      switch (stmt.kind) {
        case "let":
          if (shouldVisitPatterns) {
            if (visitPattern(stmt.pattern)) return true;
          }
          if (visitExpression(stmt.initializer)) return true;
          break;
        case "expr-stmt":
          if (visitExpression(stmt.expr)) return true;
          break;
        case "return":
          if (typeof stmt.value === "number") {
            if (visitExpression(stmt.value)) return true;
          }
          break;
      }
    }

    onExitStatement?.(id, stmt);
    return false;
  };

  visitExpression(exprId);
};
