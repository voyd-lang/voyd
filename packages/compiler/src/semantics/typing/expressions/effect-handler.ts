import { walkExpression, type HirEffectHandlerExpr } from "../../hir/index.js";
import { typeExpression } from "../expressions.js";
import {
  composeEffectRows,
  effectOpName,
  freshOpenEffectRow,
  getExprEffectRow,
} from "../effects.js";
import {
  ensureTypeMatches,
  resolveTypeExpr,
  typeSatisfies,
} from "../type-system.js";
import type { TypingContext, TypingState } from "../types.js";
import { emitDiagnostic } from "../../../diagnostics/index.js";
import type {
  HirExprId,
  SymbolId,
  SourceSpan,
  TypeId,
  TypeParamId,
} from "../../ids.js";

const dropHandledOperation = ({
  row,
  opName,
  ctx,
}: {
  row: number;
  opName: string;
  ctx: TypingContext;
}): number => {
  const desc = ctx.effects.getRow(row);
  return ctx.effects.internRow({
    operations: desc.operations.filter((op) => op.name !== opName),
    tailVar: desc.tailVar,
  });
};

const typesMatch = (
  left: TypeId,
  right: TypeId,
  ctx: TypingContext,
  state: TypingState,
): boolean =>
  typeSatisfies(left, right, ctx, state) &&
  typeSatisfies(right, left, ctx, state);

const overloadOptionsFor = (
  symbol: SymbolId,
  ctx: TypingContext,
): readonly SymbolId[] | undefined => {
  for (const options of ctx.overloads.values()) {
    if (options.includes(symbol)) {
      return options;
    }
  }
  return undefined;
};

const collectEffectOperationTypeArguments = ({
  rootExprId,
  operation,
  ctx,
  callerInstanceKey,
}: {
  rootExprId: HirExprId;
  operation: SymbolId;
  ctx: TypingContext;
  callerInstanceKey?: string;
}): readonly TypeId[][] => {
  const collected: TypeId[][] = [];
  walkExpression({
    exprId: rootExprId,
    hir: ctx.hir,
    options: { skipEffectHandlers: true },
    onEnterExpression: (_exprId, expr) => {
      if (expr.exprKind !== "call") {
        return;
      }
      const callee = ctx.hir.expressions.get(expr.callee);
      if (callee?.exprKind !== "identifier" || callee.symbol !== operation) {
        return;
      }
      const typeArgsByInstance = ctx.callResolution.typeArguments.get(expr.id);
      if (!typeArgsByInstance) {
        return;
      }
      if (callerInstanceKey) {
        const typeArgs = typeArgsByInstance.get(callerInstanceKey);
        if (typeArgs && typeArgs.length > 0) {
          collected.push([...typeArgs]);
        }
        return;
      }
      typeArgsByInstance.forEach((typeArgs) => {
        if (typeArgs.length > 0) {
          collected.push([...typeArgs]);
        }
      });
    },
  });
  return collected;
};

const resolveHandlerTypeArguments = ({
  handlerBody,
  clause,
  signature,
  ctx,
  state,
}: {
  handlerBody: HirExprId;
  clause: HirEffectHandlerExpr["handlers"][number];
  signature: NonNullable<
    ReturnType<TypingContext["functions"]["getSignature"]>
  >;
  ctx: TypingContext;
  state: TypingState;
}): readonly TypeId[] | undefined => {
  const typeParams = signature.typeParams ?? [];
  if (typeParams.length === 0) {
    return undefined;
  }

  const candidates = collectEffectOperationTypeArguments({
    rootExprId: handlerBody,
    operation: clause.operation,
    ctx,
    callerInstanceKey: state.currentFunction?.instanceKey,
  });
  if (candidates.length === 0) {
    return undefined;
  }

  const first = candidates[0]!;
  const compatible = candidates.every((candidate) => {
    if (candidate.length !== first.length) return false;
    return candidate.every((entry, index) => entry === first[index]);
  });
  if (!compatible) {
    const span =
      ctx.hir.expressions.get(handlerBody)?.span ??
      ctx.hir.expressions.get(clause.body)?.span;
    if (!span) {
      throw new Error("missing span for effect handler clause");
    }
    emitDiagnostic({
      ctx,
      code: "TY0018",
      params: {
        kind: "effect-generic-mismatch",
        operation: effectOpName(clause.operation, ctx),
        message:
          "effect operation performed with multiple instantiations in the same try body",
      },
      span,
    });
  }

  return first;
};

const applyTypeArgumentsToSignature = ({
  signature,
  typeArguments,
  ctx,
}: {
  signature: NonNullable<
    ReturnType<TypingContext["functions"]["getSignature"]>
  >;
  typeArguments: readonly TypeId[] | undefined;
  ctx: TypingContext;
}): {
  parameters: readonly (typeof signature.parameters)[number][];
  returnType: TypeId;
} => {
  const typeParams = signature.typeParams ?? [];
  if (!typeArguments || typeArguments.length === 0 || typeParams.length === 0) {
    return {
      parameters: signature.parameters,
      returnType: signature.returnType,
    };
  }

  const substitution = new Map<TypeParamId, TypeId>();
  typeParams.forEach((param, index) => {
    const arg = typeArguments[index];
    if (typeof arg === "number") {
      substitution.set(param.typeParam, arg);
    }
  });

  if (substitution.size === 0) {
    return {
      parameters: signature.parameters,
      returnType: signature.returnType,
    };
  }

  return {
    parameters: signature.parameters.map((param) => ({
      ...param,
      type: ctx.arena.substitute(param.type, substitution),
    })),
    returnType: ctx.arena.substitute(signature.returnType, substitution),
  };
};

const resolveHandlerOperation = ({
  handlerBody,
  clause,
  ctx,
  state,
}: {
  handlerBody: HirExprId;
  clause: HirEffectHandlerExpr["handlers"][number];
  ctx: TypingContext;
  state: TypingState;
}): SymbolId => {
  const overloads = overloadOptionsFor(clause.operation, ctx);
  if (!overloads || overloads.length < 2) {
    return clause.operation;
  }

  const continuationParam = clause.parameters[0];
  const argParams = clause.parameters.slice(continuationParam ? 1 : 0);
  const missingAnnotation = argParams.find((param) => !param.type);
  if (missingAnnotation) {
    const span =
      missingAnnotation.span ??
      ctx.hir.expressions.get(clause.body)?.span ??
      ctx.hir.expressions.get(handlerBody)?.span;
    if (!span) {
      throw new Error("missing span for effect handler clause");
    }
    emitDiagnostic({
      ctx,
      code: "TY0019",
      params: {
        kind: "effect-handler-overload",
        operation: effectOpName(clause.operation, ctx),
        message: "annotate handler parameter types to disambiguate overloads",
      },
      span,
    });
  }

  const resolvedArgTypes = argParams.map((param) =>
    resolveTypeExpr(param.type, ctx, state, ctx.primitives.unknown),
  );

  const matches = overloads.filter((candidate) => {
    const signature = ctx.functions.getSignature(candidate);
    if (!signature) {
      return false;
    }
    if (signature.parameters.length !== resolvedArgTypes.length) {
      return false;
    }
    return signature.parameters.every((param, index) =>
      typesMatch(param.type, resolvedArgTypes[index]!, ctx, state),
    );
  });

  if (matches.length !== 1) {
    const span =
      ctx.hir.expressions.get(clause.body)?.span ??
      ctx.hir.expressions.get(handlerBody)?.span;
    if (!span) {
      throw new Error("missing span for effect handler clause");
    }
    emitDiagnostic({
      ctx,
      code: "TY0019",
      params: {
        kind: "effect-handler-overload",
        operation: effectOpName(clause.operation, ctx),
        message:
          matches.length === 0
            ? "handler annotations do not match any overload"
            : "handler annotations match multiple overloads",
      },
      span,
    });
    return clause.operation;
  }

  return matches[0]!;
};

const typeHandlerClause = ({
  handlerBody,
  clause,
  handlerReturnTypeId,
  continuationEffectRow,
  ctx,
  state,
}: {
  handlerBody: HirExprId;
  clause: HirEffectHandlerExpr["handlers"][number];
  handlerReturnTypeId: TypeId;
  continuationEffectRow: number;
  ctx: TypingContext;
  state: TypingState;
}): number => {
  const signature = ctx.functions.getSignature(clause.operation);
  if (!signature) {
    throw new Error(
      `missing effect operation signature for ${effectOpName(
        clause.operation,
        ctx,
      )}`,
    );
  }

  const typeArguments = resolveHandlerTypeArguments({
    handlerBody,
    clause,
    signature,
    ctx,
    state,
  });
  const instantiated = applyTypeArgumentsToSignature({
    signature,
    typeArguments,
    ctx,
  });

  const continuationParam = clause.parameters[0];
  if (continuationParam) {
    const continuationParameters =
      instantiated.returnType === ctx.primitives.void
        ? []
        : [
            {
              type: instantiated.returnType,
              optional: false,
            },
          ];
    const continuationType = ctx.arena.internFunction({
      parameters: continuationParameters,
      returnType: handlerReturnTypeId,
      effectRow: continuationEffectRow,
    });
    ctx.valueTypes.set(continuationParam.symbol, continuationType);
  }

  clause.parameters.slice(continuationParam ? 1 : 0).forEach((param, index) => {
    const paramType =
      instantiated.parameters[index]?.type ?? ctx.primitives.unknown;
    ctx.valueTypes.set(param.symbol, paramType);
  });

  const clauseReturn = typeExpression(
    clause.body,
    ctx,
    state,
    { expectedType: handlerReturnTypeId },
  );
  if (handlerReturnTypeId !== ctx.primitives.unknown) {
    ensureTypeMatches(
      clauseReturn,
      handlerReturnTypeId,
      ctx,
      state,
      "handler body",
    );
  }

  return getExprEffectRow(clause.body, ctx);
};

type ContinuationUsage = { min: number; max: number; escapes: boolean };

const mergeUsage = (
  left: ContinuationUsage,
  right: ContinuationUsage,
): ContinuationUsage => ({
  min: left.min + right.min,
  max: left.max + right.max,
  escapes: left.escapes || right.escapes,
});

const mergeBranches = (branches: ContinuationUsage[]): ContinuationUsage => {
  if (branches.length === 0) {
    return { min: 0, max: 0, escapes: false };
  }
  return branches.reduce(
    (acc, branch) => ({
      min: Math.min(acc.min, branch.min),
      max: Math.max(acc.max, branch.max),
      escapes: acc.escapes || branch.escapes,
    }),
    { min: Number.POSITIVE_INFINITY, max: 0, escapes: false },
  );
};

const analyzeContinuationUsage = ({
  exprId,
  targetSymbol,
  ctx,
  nested,
}: {
  exprId: HirExprId;
  targetSymbol: SymbolId;
  ctx: TypingContext;
  nested?: boolean;
}): ContinuationUsage => {
  const emptyUsage: ContinuationUsage = { min: 0, max: 0, escapes: false };
  const usageByExpr = new Map<number, ContinuationUsage>();
  const usageByStmt = new Map<number, ContinuationUsage>();
  const usageForExpr = (id?: number): ContinuationUsage =>
    typeof id === "number" ? (usageByExpr.get(id) ?? emptyUsage) : emptyUsage;
  const usageForStmt = (id: number): ContinuationUsage =>
    usageByStmt.get(id) ?? emptyUsage;
  const toLoopUsage = (usage: ContinuationUsage): ContinuationUsage => ({
    min: 0,
    max: usage.max > 0 ? Number.POSITIVE_INFINITY : 0,
    escapes: usage.escapes,
  });

  let nestedLambdaDepth = nested ? 1 : 0;

  walkExpression({
    exprId,
    hir: ctx.hir,
    onEnterExpression: (_id, expr) => {
      if (expr.exprKind === "lambda") {
        nestedLambdaDepth += 1;
      }
    },
    onExitStatement: (stmtId, stmt) => {
      const usage =
        stmt.kind === "let"
          ? usageForExpr(stmt.initializer)
          : stmt.kind === "expr-stmt"
            ? usageForExpr(stmt.expr)
            : typeof stmt.value === "number"
              ? usageForExpr(stmt.value)
              : emptyUsage;
      usageByStmt.set(stmtId, usage);
    },
    onExitExpression: (id, expr) => {
      let usage = emptyUsage;
      switch (expr.exprKind) {
        case "identifier":
          usage =
            expr.symbol === targetSymbol
              ? { min: 0, max: 0, escapes: true }
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
          const callee = ctx.hir.expressions.get(expr.callee);
          usage =
            callee?.exprKind === "identifier" && callee.symbol === targetSymbol
              ? { min: 1, max: 1, escapes: nestedLambdaDepth > 0 }
              : usageForExpr(expr.callee);
          expr.args.forEach((arg) => {
            usage = mergeUsage(usage, usageForExpr(arg.expr));
          });
          break;
        }
        case "block":
          usage = expr.statements.reduce(
            (acc, stmtId) => mergeUsage(acc, usageForStmt(stmtId)),
            emptyUsage,
          );
          if (typeof expr.value === "number") {
            usage = mergeUsage(usage, usageForExpr(expr.value));
          }
          break;
        case "tuple":
          usage = expr.elements.reduce(
            (acc, entry) => mergeUsage(acc, usageForExpr(entry)),
            emptyUsage,
          );
          break;
        case "loop":
          usage = toLoopUsage(usageForExpr(expr.body));
          break;
        case "while":
          usage = mergeUsage(
            usageForExpr(expr.condition),
            toLoopUsage(usageForExpr(expr.body)),
          );
          break;
        case "cond":
        case "if": {
          const branchUsages = expr.branches.map((branch) =>
            mergeUsage(
              usageForExpr(branch.condition),
              usageForExpr(branch.value),
            ),
          );
          const defaultUsage =
            typeof expr.defaultBranch === "number"
              ? usageForExpr(expr.defaultBranch)
              : emptyUsage;
          usage = mergeBranches([...branchUsages, defaultUsage]);
          break;
        }
        case "match": {
          const discriminantUsage = usageForExpr(expr.discriminant);
          const armUsages = expr.arms.map((arm) => {
            const guardUsage =
              typeof arm.guard === "number"
                ? usageForExpr(arm.guard)
                : emptyUsage;
            return mergeUsage(guardUsage, usageForExpr(arm.value));
          });
          usage = mergeUsage(discriminantUsage, mergeBranches(armUsages));
          break;
        }
        case "effect-handler": {
          usage = usageForExpr(expr.body);
          expr.handlers.forEach((handler) => {
            usage = mergeUsage(usage, usageForExpr(handler.body));
          });
          if (typeof expr.finallyBranch === "number") {
            usage = mergeUsage(usage, usageForExpr(expr.finallyBranch));
          }
          break;
        }
        case "object-literal":
          usage = expr.entries.reduce(
            (acc, entry) => mergeUsage(acc, usageForExpr(entry.value)),
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
          usage = mergeUsage(targetUsage, usageForExpr(expr.value));
          break;
        }
        case "lambda": {
          const inner = usageForExpr(expr.body);
          usage =
            inner.min > 0 || inner.max > 0 || inner.escapes
              ? { min: inner.min, max: inner.max, escapes: true }
              : inner;
          nestedLambdaDepth -= 1;
          break;
        }
      }
      usageByExpr.set(id, usage);
    },
  });

  return usageByExpr.get(exprId) ?? emptyUsage;
};

const enforceTailResumption = ({
  clause,
  ctx,
  opName,
  span,
}: {
  clause: HirEffectHandlerExpr["handlers"][number];
  ctx: TypingContext;
  opName: string;
  span: SourceSpan;
}): void => {
  const operationDecl = ctx.decls.getEffectOperation(clause.operation);
  if (operationDecl?.operation.resumable !== "tail") {
    return;
  }
  const continuationSymbol = clause.parameters[0]?.symbol;
  const usage =
    typeof continuationSymbol === "number"
      ? analyzeContinuationUsage({
          exprId: clause.body,
          targetSymbol: continuationSymbol,
          ctx,
        })
      : { min: 0, max: 0, escapes: false };

  const staticallyExactOnce =
    !usage.escapes && usage.min === 1 && usage.max === 1;
  const definitelyMissing =
    !usage.escapes && usage.min === 0 && usage.max === 0;
  const definitelyMultiple = !usage.escapes && usage.min > 1 && usage.max > 1;
  const enforcement: "static" | "runtime" =
    usage.escapes || !staticallyExactOnce ? "runtime" : "static";

  clause.tailResumption = {
    enforcement,
    calls: usage.max,
    minCalls: usage.min,
    escapes: usage.escapes,
  };

  ctx.tailResumptions.set(clause.body, clause.tailResumption);

  if (definitelyMissing || definitelyMultiple) {
    emitDiagnostic({
      ctx,
      code: "TY0015",
      params: {
        kind: "tail-resume-count",
        operation: opName,
        count: usage.max,
      },
      span,
    });
  }
};

export const typeEffectHandlerExpr = (
  expr: HirEffectHandlerExpr,
  ctx: TypingContext,
  state: TypingState,
  expectedType?: TypeId,
): number => {
  const bodyType = typeExpression(expr.body, ctx, state, { expectedType });
  const bodyEffectRow = getExprEffectRow(expr.body, ctx);
  const handlerReturnTypeId =
    expectedType ?? state.currentFunction?.returnType ?? bodyType;

  expr.handlers.forEach((clause) => {
    const resolved = resolveHandlerOperation({
      handlerBody: expr.body,
      clause,
      ctx,
      state,
    });
    if (resolved !== clause.operation) {
      clause.operation = resolved;
    }
  });

  const handlerEffects: number[] = [];
  let remainingRow = bodyEffectRow;
  const reRaisedOps = new Set<string>();
  const handledOpNames = new Set(
    expr.handlers.map((clause) => effectOpName(clause.operation, ctx)),
  );
  const continuationEffectRow = Array.from(handledOpNames).reduce(
    (row, opName) => dropHandledOperation({ row, opName, ctx }),
    bodyEffectRow,
  );

  expr.handlers.forEach((clause) => {
    const opName = effectOpName(clause.operation, ctx);
    const clauseEffectRow = typeHandlerClause({
      handlerBody: expr.body,
      clause,
      handlerReturnTypeId,
      continuationEffectRow,
      ctx,
      state,
    });
    handlerEffects.push(clauseEffectRow);
    const clauseDesc = ctx.effects.getRow(clauseEffectRow);
    const reRaises = clauseDesc.operations.some((op) => op.name === opName);
    if (reRaises) {
      reRaisedOps.add(opName);
    } else {
      remainingRow = dropHandledOperation({ row: remainingRow, opName, ctx });
    }
    const clauseSpan = ctx.hir.expressions.get(clause.body)?.span ?? expr.span;
    enforceTailResumption({ clause, ctx, opName, span: clauseSpan });
  });

  const handlersRow = composeEffectRows(ctx.effects, handlerEffects);
  let effectRow = composeEffectRows(ctx.effects, [remainingRow, handlersRow]);

  if (typeof expr.finallyBranch === "number") {
    const finallyType = typeExpression(
      expr.finallyBranch,
      ctx,
      state,
      { expectedType: bodyType },
    );
    if (bodyType !== ctx.primitives.unknown) {
      ensureTypeMatches(finallyType, bodyType, ctx, state, "handler finally");
    }
    effectRow = composeEffectRows(ctx.effects, [
      effectRow,
      getExprEffectRow(expr.finallyBranch, ctx),
    ]);
  }

  const remainingDesc = ctx.effects.getRow(remainingRow);
  const unhandled = remainingDesc.operations.filter(
    (op) => !reRaisedOps.has(op.name),
  );
  if (unhandled.length > 0 && !remainingDesc.tailVar) {
    const opList = unhandled.map((op) => op.name).join(", ");
    emitDiagnostic({
      ctx,
      code: "TY0013",
      params: { kind: "unhandled-effects", operations: opList },
      span: expr.span,
    });
  }

  ctx.effects.setExprEffect(expr.id, effectRow);
  return bodyType;
};
