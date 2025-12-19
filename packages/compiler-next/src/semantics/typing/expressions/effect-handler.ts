import type { HirEffectHandlerExpr } from "../../hir/index.js";
import { typeExpression } from "../expressions.js";
import {
  composeEffectRows,
  effectOpName,
  freshOpenEffectRow,
  getExprEffectRow,
} from "../effects.js";
import { ensureTypeMatches, resolveTypeExpr, typeSatisfies } from "../type-system.js";
import type { TypingContext, TypingState } from "../types.js";
import { emitDiagnostic } from "../../../diagnostics/index.js";
import type { HirExprId, SymbolId, SourceSpan, TypeId, TypeParamId } from "../../ids.js";

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
  state: TypingState
): boolean => typeSatisfies(left, right, ctx, state) && typeSatisfies(right, left, ctx, state);

const overloadOptionsFor = (
  symbol: SymbolId,
  ctx: TypingContext
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
}: {
  rootExprId: HirExprId;
  operation: SymbolId;
  ctx: TypingContext;
}): readonly TypeId[][] => {
  const collected: TypeId[][] = [];
  const visitExpression = (exprId: HirExprId): void => {
    const expr = ctx.hir.expressions.get(exprId);
    if (!expr) return;

    switch (expr.exprKind) {
      case "literal":
      case "identifier":
      case "overload-set":
      case "continue":
        return;
      case "break":
        if (typeof expr.value === "number") visitExpression(expr.value);
        return;
      case "lambda":
        visitExpression(expr.body);
        return;
      case "effect-handler":
        return;
      case "block":
        expr.statements.forEach((stmtId) => {
          const stmt = ctx.hir.statements.get(stmtId);
          if (!stmt) return;
          if (stmt.kind === "let") visitExpression(stmt.initializer);
          if (stmt.kind === "expr-stmt") visitExpression(stmt.expr);
          if (stmt.kind === "return" && typeof stmt.value === "number") {
            visitExpression(stmt.value);
          }
        });
        if (typeof expr.value === "number") visitExpression(expr.value);
        return;
      case "call": {
        const callee = ctx.hir.expressions.get(expr.callee);
        if (callee?.exprKind === "identifier" && callee.symbol === operation) {
          const typeArgs = ctx.callResolution.typeArguments.get(expr.id);
          if (typeArgs && typeArgs.length > 0) {
            collected.push([...typeArgs]);
          }
        }
        visitExpression(expr.callee);
        expr.args.forEach((arg) => visitExpression(arg.expr));
        return;
      }
      case "tuple":
        expr.elements.forEach(visitExpression);
        return;
      case "loop":
        visitExpression(expr.body);
        return;
      case "while":
        visitExpression(expr.condition);
        visitExpression(expr.body);
        return;
      case "cond":
      case "if":
        expr.branches.forEach((branch) => {
          visitExpression(branch.condition);
          visitExpression(branch.value);
        });
        if (typeof expr.defaultBranch === "number") {
          visitExpression(expr.defaultBranch);
        }
        return;
      case "match":
        visitExpression(expr.discriminant);
        expr.arms.forEach((arm) => {
          if (typeof arm.guard === "number") visitExpression(arm.guard);
          visitExpression(arm.value);
        });
        return;
      case "object-literal":
        expr.entries.forEach((entry) => visitExpression(entry.value));
        return;
      case "field-access":
        visitExpression(expr.target);
        return;
      case "assign":
        if (typeof expr.target === "number") visitExpression(expr.target);
        visitExpression(expr.value);
        return;
    }
  };

  visitExpression(rootExprId);
  return collected;
};

const resolveHandlerTypeArguments = ({
  handlerBody,
  clause,
  signature,
  ctx,
}: {
  handlerBody: HirExprId;
  clause: HirEffectHandlerExpr["handlers"][number];
  signature: NonNullable<ReturnType<TypingContext["functions"]["getSignature"]>>;
  ctx: TypingContext;
}): readonly TypeId[] | undefined => {
  const typeParams = signature.typeParams ?? [];
  if (typeParams.length === 0) {
    return undefined;
  }

  const candidates = collectEffectOperationTypeArguments({
    rootExprId: handlerBody,
    operation: clause.operation,
    ctx,
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
  signature: NonNullable<ReturnType<TypingContext["functions"]["getSignature"]>>;
  typeArguments: readonly TypeId[] | undefined;
  ctx: TypingContext;
}): {
  parameters: readonly (typeof signature.parameters)[number][];
  returnType: TypeId;
} => {
  const typeParams = signature.typeParams ?? [];
  if (!typeArguments || typeArguments.length === 0 || typeParams.length === 0) {
    return { parameters: signature.parameters, returnType: signature.returnType };
  }

  const substitution = new Map<TypeParamId, TypeId>();
  typeParams.forEach((param, index) => {
    const arg = typeArguments[index];
    if (typeof arg === "number") {
      substitution.set(param.typeParam, arg);
    }
  });

  if (substitution.size === 0) {
    return { parameters: signature.parameters, returnType: signature.returnType };
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
    resolveTypeExpr(param.type, ctx, state, ctx.primitives.unknown)
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
      typesMatch(param.type, resolvedArgTypes[index]!, ctx, state)
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
        ctx
      )}`
    );
  }

  const typeArguments = resolveHandlerTypeArguments({
    handlerBody,
    clause,
    signature,
    ctx,
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

  const clauseReturn = typeExpression(clause.body, ctx, state, handlerReturnTypeId);
  if (handlerReturnTypeId !== ctx.primitives.unknown) {
    ensureTypeMatches(
      clauseReturn,
      handlerReturnTypeId,
      ctx,
      state,
      "handler body"
    );
  }

  return getExprEffectRow(clause.body, ctx);
};

type ContinuationUsage = { min: number; max: number; escapes: boolean };

const mergeUsage = (
  left: ContinuationUsage,
  right: ContinuationUsage
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
    { min: Number.POSITIVE_INFINITY, max: 0, escapes: false }
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
  const visitExpression = (
    id: HirExprId,
    inNestedLambda: boolean
  ): ContinuationUsage => {
    const expr = ctx.hir.expressions.get(id);
    if (!expr) {
      throw new Error(`missing HirExpression ${id}`);
    }

    switch (expr.exprKind) {
      case "identifier":
        return expr.symbol === targetSymbol
          ? { min: 0, max: 0, escapes: true }
          : { min: 0, max: 0, escapes: false };
      case "literal":
      case "overload-set":
      case "continue":
        return { min: 0, max: 0, escapes: false };
      case "break":
        return typeof expr.value === "number"
          ? visitExpression(expr.value, inNestedLambda)
          : { min: 0, max: 0, escapes: false };
      case "call": {
        const callee = ctx.hir.expressions.get(expr.callee);
        let usage =
          callee?.exprKind === "identifier" && callee.symbol === targetSymbol
            ? { min: 1, max: 1, escapes: Boolean(inNestedLambda) }
            : visitExpression(expr.callee, inNestedLambda);
        expr.args.forEach((arg) => {
          usage = mergeUsage(usage, visitExpression(arg.expr, inNestedLambda));
        });
        return usage;
      }
      case "block": {
        let usage = expr.statements.reduce(
          (acc, stmtId) => mergeUsage(acc, visitStatement(stmtId, inNestedLambda)),
          { min: 0, max: 0, escapes: false }
        );
        if (typeof expr.value === "number") {
          usage = mergeUsage(usage, visitExpression(expr.value, inNestedLambda));
        }
        return usage;
      }
      case "tuple":
        return expr.elements.reduce<ContinuationUsage>(
          (acc, entry) => mergeUsage(acc, visitExpression(entry, inNestedLambda)),
          { min: 0, max: 0, escapes: false }
        );
      case "loop":
        const loopUsage = analyzeContinuationUsage({
          exprId: expr.body,
          targetSymbol,
          ctx,
          nested: inNestedLambda,
        });
        return {
          min: 0,
          max: loopUsage.max > 0 ? Number.POSITIVE_INFINITY : 0,
          escapes: loopUsage.escapes,
        };
      case "while":
        const whileBody = analyzeContinuationUsage({
          exprId: expr.body,
          targetSymbol,
          ctx,
          nested: inNestedLambda,
        });
        return mergeUsage(visitExpression(expr.condition, inNestedLambda), {
          min: 0,
          max: whileBody.max > 0 ? Number.POSITIVE_INFINITY : 0,
          escapes: whileBody.escapes,
        });
      case "cond":
      case "if": {
        const branchUsages = expr.branches.map((branch) =>
          mergeUsage(
            visitExpression(branch.condition, inNestedLambda),
            visitExpression(branch.value, inNestedLambda)
          )
        );
        const defaultUsage =
          typeof expr.defaultBranch === "number"
            ? visitExpression(expr.defaultBranch, inNestedLambda)
            : { min: 0, max: 0, escapes: false };
        return mergeBranches([...branchUsages, defaultUsage]);
      }
      case "match": {
        let usage = visitExpression(expr.discriminant, inNestedLambda);
        const armUsages = expr.arms.map((arm) => {
          let armUsage =
            typeof arm.guard === "number"
              ? visitExpression(arm.guard, inNestedLambda)
              : { min: 0, max: 0, escapes: false };
          armUsage = mergeUsage(
            armUsage,
            visitExpression(arm.value, inNestedLambda)
          );
          return armUsage;
        });
        return mergeUsage(usage, mergeBranches(armUsages));
      }
      case "effect-handler": {
        let usage = visitExpression(expr.body, inNestedLambda);
        expr.handlers.forEach((handler) => {
          usage = mergeUsage(usage, visitExpression(handler.body, inNestedLambda));
        });
        if (typeof expr.finallyBranch === "number") {
          usage = mergeUsage(
            usage,
            visitExpression(expr.finallyBranch, inNestedLambda)
          );
        }
        return usage;
      }
      case "object-literal":
        return expr.entries.reduce<ContinuationUsage>(
          (acc, entry) =>
            mergeUsage(acc, visitExpression(entry.value, inNestedLambda)),
          { min: 0, max: 0, escapes: false }
        );
      case "field-access":
        return visitExpression(expr.target, inNestedLambda);
      case "assign": {
        const targetUsage =
          typeof expr.target === "number"
            ? visitExpression(expr.target, inNestedLambda)
            : { min: 0, max: 0, escapes: false };
        return mergeUsage(
          targetUsage,
          visitExpression(expr.value, inNestedLambda)
        );
      }
      case "lambda": {
        const inner = visitExpression(expr.body, true);
        return inner.min > 0 || inner.max > 0 || inner.escapes
          ? { min: inner.min, max: inner.max, escapes: true }
          : inner;
      }
    }

    return { min: 0, max: 0, escapes: false };
  };

  const visitStatement = (
    id: number,
    inNestedLambda: boolean
  ): ContinuationUsage => {
    const stmt = ctx.hir.statements.get(id);
    if (!stmt) {
      throw new Error(`missing HirStatement ${id}`);
    }
    switch (stmt.kind) {
      case "let":
        return visitExpression(stmt.initializer, inNestedLambda);
      case "expr-stmt":
        return visitExpression(stmt.expr, inNestedLambda);
      case "return":
        return typeof stmt.value === "number"
          ? visitExpression(stmt.value, inNestedLambda)
          : { min: 0, max: 0, escapes: false };
    }

    return { min: 0, max: 0, escapes: false };
  };

  return visitExpression(exprId, Boolean(nested));
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
  const definitelyMissing = !usage.escapes && usage.min === 0 && usage.max === 0;
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
  expectedType?: TypeId
): number => {
  const bodyType = typeExpression(expr.body, ctx, state, expectedType);
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
    expr.handlers.map((clause) => effectOpName(clause.operation, ctx))
  );
  const continuationEffectRow = Array.from(handledOpNames).reduce(
    (row, opName) => dropHandledOperation({ row, opName, ctx }),
    bodyEffectRow
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
    const clauseSpan =
      ctx.hir.expressions.get(clause.body)?.span ?? expr.span;
    enforceTailResumption({ clause, ctx, opName, span: clauseSpan });
  });

  const handlersRow = composeEffectRows(ctx.effects, handlerEffects);
  let effectRow = composeEffectRows(ctx.effects, [remainingRow, handlersRow]);

  if (typeof expr.finallyBranch === "number") {
    const finallyType = typeExpression(expr.finallyBranch, ctx, state, bodyType);
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
    (op) => !reRaisedOps.has(op.name)
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
