import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirBlockExpr,
  HirLetStatement,
  HirStmtId,
  SymbolId,
  TypeId,
} from "../context.js";
import { walkHirExpression } from "../hir-walk.js";
import type { HirStatement } from "../../semantics/index.js";
import { compilePatternInitialization } from "../patterns.js";
import {
  expressionUsesProjectedRootUnsafely,
  tryCompileProjectedElementBinding,
  tryResolveProjectedElementRootSymbol,
} from "../projected-element-views.js";
import { coerceValueToType, storeValueIntoStorageRef } from "../structural.js";
import {
  getDeclaredSymbolTypeId,
  getRequiredExprType,
  wasmTypeFor,
} from "../types.js";
import { asStatement, coerceToBinaryenType } from "./utils.js";
import { wrapValueInOutcome } from "../effects/outcome-values.js";
import { handlerCleanupOps } from "../effects/handler-stack.js";
import { tailResumptionExitChecks } from "../effects/tail-resumptions.js";
import { boxSignatureSpillValue } from "../signature-spill.js";

const expressionUsesExpectedResultType = ({
  exprId,
  ctx,
}: {
  exprId: number;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return false;
  }
  switch (expr.exprKind) {
    case "identifier":
    case "call":
    case "method-call":
    case "block":
    case "if":
    case "match":
    case "effect-handler":
      return true;
    default:
      return false;
  }
};

export const withBlockScope = <T>({
  expr,
  ctx,
  fnCtx,
  run,
}: {
  expr: HirBlockExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  run: () => T;
}): T => {
  const previousAliases = fnCtx.simpleIdentifierAliases;
  const aliasSets = mergeSimpleIdentifierAliases({
    base: previousAliases,
    next: collectSimpleIdentifierAliases({ expr, ctx }),
  });
  const previousNonBorrowable = fnCtx.nonBorrowableProjectedSymbols;
  fnCtx.simpleIdentifierAliases = aliasSets;
  fnCtx.nonBorrowableProjectedSymbols = collectNonBorrowableProjectedSymbols({
    expr,
    aliasSets,
    ctx,
    fnCtx,
  });
  try {
    return run();
  } finally {
    fnCtx.simpleIdentifierAliases = previousAliases;
    fnCtx.nonBorrowableProjectedSymbols = previousNonBorrowable;
  }
};

export const compileBlockExpr = (
  expr: HirBlockExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId,
  outResultStorageRef?: binaryen.ExpressionRef,
): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const blockResultTypeId =
    expectedResultTypeId ?? getRequiredExprType(expr.id, ctx, typeInstanceId);
  const blockResultType = wasmTypeFor(blockResultTypeId, ctx);
  const statements: binaryen.ExpressionRef[] = [];
  return withBlockScope({
    expr,
    ctx,
    fnCtx,
    run: () => {
      expr.statements.forEach((stmtId) => {
        statements.push(compileStatement(stmtId, ctx, fnCtx, compileExpr));
      });
      if (typeof expr.value === "number") {
        const value = compileExpr({
          exprId: expr.value,
          ctx,
          fnCtx,
          tailPosition,
          expectedResultTypeId,
          outResultStorageRef,
        });
        const { expr: valueExpr, usedReturnCall, usedOutResultStorageRef } = value;
        if (usedOutResultStorageRef) {
          if (statements.length === 0) {
            return {
              expr: valueExpr,
              usedReturnCall,
              usedOutResultStorageRef: true,
            };
          }
          return {
            expr: ctx.mod.block(null, [...statements, valueExpr], binaryen.none),
            usedReturnCall,
            usedOutResultStorageRef: true,
          };
        }
        const requiredActualType =
          typeof expectedResultTypeId === "number" &&
          !usedReturnCall &&
          expressionUsesExpectedResultType({ exprId: expr.value, ctx })
            ? expectedResultTypeId
            : getRequiredExprType(expr.value, ctx, typeInstanceId);
        const coercedToExpected =
          typeof expectedResultTypeId === "number" && !usedReturnCall
            ? coerceValueToType({
                value: valueExpr,
                actualType: requiredActualType,
                targetType: expectedResultTypeId,
                ctx,
                fnCtx,
              })
            : valueExpr;
        const coerced = coerceToBinaryenType(
          ctx,
          coercedToExpected,
          blockResultType,
          fnCtx,
        );
        if (statements.length === 0) {
          return { expr: coerced, usedReturnCall };
        }

        statements.push(coerced);
        return {
          expr: ctx.mod.block(
            null,
            statements,
            blockResultType
          ),
          usedReturnCall,
        };
      }

      if (statements.length === 0) {
        return { expr: ctx.mod.nop(), usedReturnCall: false };
      }

      return {
        expr: ctx.mod.block(null, statements, binaryen.none),
        usedReturnCall: false,
      };
    },
  });
};

export const compileStatement = (
  stmtId: HirStmtId,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): binaryen.ExpressionRef => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const stmt = ctx.module.hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`codegen missing HirStatement ${stmtId}`);
  }

  switch (stmt.kind) {
    case "expr-stmt":
      return asStatement(
        ctx,
        compileExpr({ exprId: stmt.expr, ctx, fnCtx }).expr,
        fnCtx,
      );
    case "return":
      if (typeof stmt.value === "number") {
        const returnOutResultStorageRef =
          fnCtx.returnAbiKind === "out_ref" && fnCtx.returnOutPointer
            ? ctx.mod.local.get(
                fnCtx.returnOutPointer.index,
                fnCtx.returnOutPointer.storageType,
              )
            : undefined;
        const valueExpr = compileExpr({
          exprId: stmt.value,
          ctx,
          fnCtx,
          tailPosition: true,
          expectedResultTypeId: fnCtx.returnTypeId,
          outResultStorageRef: returnOutResultStorageRef,
        });
        if (valueExpr.usedReturnCall) {
          return valueExpr.expr;
        }
        const tailChecks = tailResumptionExitChecks({ ctx, fnCtx });
        if (valueExpr.usedOutResultStorageRef) {
          const cleanup = handlerCleanupOps({ ctx, fnCtx });
          if (fnCtx.effectful) {
            const wrapped = wrapValueInOutcome({
              valueExpr: ctx.mod.nop(),
              valueType: binaryen.none,
              typeId: fnCtx.returnTypeId,
              ctx,
              fnCtx,
            });
            const ops =
              cleanup.length === 0
                ? [valueExpr.expr, ...tailChecks, ctx.mod.return(wrapped)]
                : [...tailChecks, ...cleanup, valueExpr.expr, ctx.mod.return(wrapped)];
            return ctx.mod.block(null, ops, binaryen.none);
          }
          const ops =
            cleanup.length === 0
              ? [valueExpr.expr, ...tailChecks, ctx.mod.return()]
              : [...tailChecks, ...cleanup, valueExpr.expr, ctx.mod.return()];
          return ctx.mod.block(null, ops, binaryen.none);
        }
        if (fnCtx.returnAbiKind === "out_ref" && fnCtx.returnOutPointer) {
          const storedValue = coerceValueToType({
            value: valueExpr.expr,
            actualType: getRequiredExprType(stmt.value, ctx, typeInstanceId),
            targetType: fnCtx.returnTypeId,
            ctx,
            fnCtx,
          });
          const cleanup = handlerCleanupOps({ ctx, fnCtx });
          const storeReturn = storeValueIntoStorageRef({
            pointer: () =>
              ctx.mod.local.get(
                fnCtx.returnOutPointer!.index,
                fnCtx.returnOutPointer!.storageType,
              ),
            value: storedValue,
            typeId: fnCtx.returnTypeId,
            ctx,
            fnCtx,
          });
          if (fnCtx.effectful) {
            const wrapped = wrapValueInOutcome({
              valueExpr: ctx.mod.nop(),
              valueType: binaryen.none,
              typeId: fnCtx.returnTypeId,
              ctx,
              fnCtx,
            });
            const ops =
              cleanup.length === 0
                ? [storeReturn, ...tailChecks, ctx.mod.return(wrapped)]
                : [...tailChecks, ...cleanup, storeReturn, ctx.mod.return(wrapped)];
            return ctx.mod.block(null, ops, binaryen.none);
          }
          const ops =
            cleanup.length === 0
              ? [storeReturn, ...tailChecks, ctx.mod.return()]
              : [...tailChecks, ...cleanup, storeReturn, ctx.mod.return()];
          return ctx.mod.block(null, ops, binaryen.none);
        }
        if (fnCtx.returnTypeId === ctx.program.primitives.void) {
          const cleanup = handlerCleanupOps({ ctx, fnCtx });
          const valueStmt = asStatement(ctx, valueExpr.expr, fnCtx);
          if (fnCtx.effectful) {
            const wrapped = wrapValueInOutcome({
              valueExpr: ctx.mod.nop(),
              valueType: wasmTypeFor(fnCtx.returnTypeId, ctx),
              typeId: fnCtx.returnTypeId,
              ctx,
              fnCtx,
            });
            const ops =
              cleanup.length === 0
                ? [valueStmt, ...tailChecks, ctx.mod.return(wrapped)]
                : [valueStmt, ...tailChecks, ...cleanup, ctx.mod.return(wrapped)];
            return ctx.mod.block(null, ops, binaryen.none);
          }
          const ops =
            cleanup.length === 0
              ? [valueStmt, ...tailChecks, ctx.mod.return()]
              : [valueStmt, ...tailChecks, ...cleanup, ctx.mod.return()];
          return ctx.mod.block(null, ops, binaryen.none);
        }
        const requiredActualType = getRequiredExprType(
          stmt.value,
          ctx,
          typeInstanceId
        );
        const actualTypeId =
          expressionUsesExpectedResultType({ exprId: stmt.value, ctx })
            ? fnCtx.returnTypeId
            : requiredActualType;
        const coerced = coerceValueToType({
          value: valueExpr.expr,
          actualType: actualTypeId,
          targetType: fnCtx.returnTypeId,
          ctx,
          fnCtx,
        });
        const returnedValue = boxSignatureSpillValue({
          value: coerced,
          typeId: fnCtx.returnTypeId,
          ctx,
          fnCtx,
        });
        const cleanup = handlerCleanupOps({ ctx, fnCtx });
        if (fnCtx.effectful) {
          const wrapped = wrapValueInOutcome({
            valueExpr: coerced,
            valueType: wasmTypeFor(fnCtx.returnTypeId, ctx),
            typeId: fnCtx.returnTypeId,
            ctx,
            fnCtx,
          });
          if (cleanup.length === 0) {
            return ctx.mod.block(null, [...tailChecks, ctx.mod.return(wrapped)], binaryen.none);
          }
          return ctx.mod.block(
            null,
            [...tailChecks, ...cleanup, ctx.mod.return(wrapped)],
            binaryen.none
          );
        }
        if (binaryen.getExpressionType(returnedValue) === binaryen.none) {
          if (cleanup.length === 0) {
            return ctx.mod.block(
              null,
              [returnedValue, ...tailChecks, ctx.mod.return()],
              binaryen.none
            );
          }
          return ctx.mod.block(
            null,
            [...tailChecks, ...cleanup, returnedValue, ctx.mod.return()],
            binaryen.none
          );
        }
        if (cleanup.length === 0) {
          return ctx.mod.block(null, [...tailChecks, ctx.mod.return(returnedValue)], binaryen.none);
        }
        return ctx.mod.block(
          null,
          [...tailChecks, ...cleanup, ctx.mod.return(returnedValue)],
          binaryen.none
        );
      }
      const tailChecks = tailResumptionExitChecks({ ctx, fnCtx });
      const cleanup = handlerCleanupOps({ ctx, fnCtx });
      if (fnCtx.effectful) {
        const wrapped = wrapValueInOutcome({
          valueExpr: ctx.mod.nop(),
          valueType: wasmTypeFor(fnCtx.returnTypeId, ctx),
          typeId: fnCtx.returnTypeId,
          ctx,
          fnCtx,
        });
        if (cleanup.length === 0) {
          return ctx.mod.block(null, [...tailChecks, ctx.mod.return(wrapped)], binaryen.none);
        }
        return ctx.mod.block(
          null,
          [...tailChecks, ...cleanup, ctx.mod.return(wrapped)],
          binaryen.none
        );
      }
      if (cleanup.length === 0) {
        return ctx.mod.block(null, [...tailChecks, ctx.mod.return()], binaryen.none);
      }
      return ctx.mod.block(
        null,
        [...tailChecks, ...cleanup, ctx.mod.return()],
        binaryen.none
      );
    case "let":
      return compileLetStatement(stmt, ctx, fnCtx, compileExpr);
    default:
      throw new Error("codegen cannot lower statement kind");
  }
};

const compileLetStatement = (
  stmt: HirLetStatement,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): binaryen.ExpressionRef => {
  if (stmt.pattern.kind === "identifier" && !stmt.mutable) {
    if (fnCtx.nonBorrowableProjectedSymbols?.has(stmt.pattern.symbol)) {
      return compileDefaultLetStatement(stmt, ctx, fnCtx, compileExpr);
    }
    const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
    const targetTypeId = getDeclaredSymbolTypeId(
      stmt.pattern.symbol,
      ctx,
      typeInstanceId,
    );
    const borrowedOps = tryCompileProjectedElementBinding({
      symbol: stmt.pattern.symbol,
      initializer: stmt.initializer,
      targetTypeId,
      ctx,
      fnCtx,
      compileExpr,
    });
    if (borrowedOps && borrowedOps.length > 0) {
      return ctx.mod.block(null, [...borrowedOps], binaryen.none);
    }
  }

  return compileDefaultLetStatement(stmt, ctx, fnCtx, compileExpr);
};

const compileDefaultLetStatement = (
  stmt: HirLetStatement,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): binaryen.ExpressionRef => {
  const ops: binaryen.ExpressionRef[] = [];
  compilePatternInitialization({
    pattern: stmt.pattern,
    initializer: stmt.initializer,
    ctx,
    fnCtx,
    ops,
    compileExpr,
    options: { declare: true },
  });
  if (ops.length === 0) {
    return ctx.mod.nop();
  }
  return ctx.mod.block(null, ops, binaryen.none);
};

const collectNonBorrowableProjectedSymbols = ({
  expr,
  aliasSets,
  ctx,
  fnCtx,
}: {
  expr: HirBlockExpr;
  aliasSets: ReadonlyMap<SymbolId, ReadonlySet<SymbolId>>;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): ReadonlySet<number> => {
  const symbols = new Set<number>();
  expr.statements.forEach((stmtId, index) => {
    const stmt = ctx.module.hir.statements.get(stmtId);
    if (
      stmt?.kind !== "let" ||
      stmt.mutable ||
      stmt.pattern.kind !== "identifier"
    ) {
      return;
    }

    const rootSymbol = tryResolveProjectedElementRootSymbol({
      exprId: stmt.initializer,
      ctx,
      fnCtx,
    });
    if (typeof rootSymbol !== "number") {
      return;
    }

    const rootAliases = aliasSets.get(rootSymbol) ?? new Set([rootSymbol]);
    if (
      laterBlockCodeUsesAnySymbol({
        expr,
        startStatementIndex: index + 1,
        symbols: rootAliases,
        ctx,
        fnCtx,
      })
    ) {
      symbols.add(stmt.pattern.symbol);
    }
  });

  walkHirExpression({
    exprId: expr.id,
    ctx,
    visitor: {
      onExpr: (_exprId, node) => {
        if (node.exprKind !== "call" || node.args.length !== 1) {
          return;
        }
        const callee = ctx.module.hir.expressions.get(node.callee);
        if (callee?.exprKind !== "identifier") {
          return;
        }
        const calleeId = ctx.program.symbols.canonicalIdOf(ctx.moduleId, callee.symbol);
        if (
          ctx.program.symbols.getIntrinsicName(calleeId) !== "~" &&
          ctx.program.symbols.getName(calleeId) !== "~"
        ) {
          return;
        }
        const argExpr = ctx.module.hir.expressions.get(node.args[0]!.expr);
        if (argExpr?.exprKind === "identifier") {
          symbols.add(argExpr.symbol);
        }
      },
    },
  });
  return symbols;
};

const mergeSimpleIdentifierAliases = ({
  base,
  next,
}: {
  base?: ReadonlyMap<SymbolId, ReadonlySet<SymbolId>>;
  next: ReadonlyMap<SymbolId, ReadonlySet<SymbolId>>;
}): ReadonlyMap<SymbolId, ReadonlySet<SymbolId>> => {
  if (!base || base.size === 0) {
    return next;
  }
  if (next.size === 0) {
    return base;
  }

  const adjacency = new Map<SymbolId, Set<SymbolId>>();
  const linkComponent = (component: ReadonlySet<SymbolId>): void => {
    const members = [...component];
    members.forEach((member) => {
      const neighbors = adjacency.get(member) ?? new Set<SymbolId>();
      members.forEach((neighbor) => {
        if (neighbor !== member) {
          neighbors.add(neighbor);
        }
      });
      adjacency.set(member, neighbors);
    });
  };

  base.forEach((component) => linkComponent(component));
  next.forEach((component) => linkComponent(component));

  const merged = new Map<SymbolId, ReadonlySet<SymbolId>>();
  adjacency.forEach((_neighbors, symbol) => {
    if (merged.has(symbol)) {
      return;
    }
    const component = new Set<SymbolId>();
    const queue = [symbol];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (component.has(current)) {
        continue;
      }
      component.add(current);
      (adjacency.get(current) ?? new Set<SymbolId>()).forEach((neighbor) => {
        queue.push(neighbor);
      });
    }
    component.forEach((member) => merged.set(member, component));
  });

  return merged;
};

const laterBlockCodeUsesAnySymbol = ({
  expr,
  startStatementIndex,
  symbols,
  ctx,
  fnCtx,
}: {
  expr: HirBlockExpr;
  startStatementIndex: number;
  symbols: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): boolean => {
  for (let index = startStatementIndex; index < expr.statements.length; index += 1) {
    const stmt = ctx.module.hir.statements.get(expr.statements[index]!);
    if (stmt && statementUsesAnySymbol({ stmt, symbols, ctx, fnCtx })) {
      return true;
    }
  }

  return (
    typeof expr.value === "number" &&
    expressionUsesAnySymbol({
      exprId: expr.value,
      symbols,
      ctx,
      fnCtx,
    })
  );
};

const statementUsesAnySymbol = ({
  stmt,
  symbols,
  ctx,
  fnCtx,
}: {
  stmt: HirStatement;
  symbols: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): boolean => {
  switch (stmt.kind) {
    case "let":
      if (
        stmt.pattern.kind === "identifier" &&
        isSimpleIdentifierAliasExpr({
          exprId: stmt.initializer,
          symbols,
          ctx,
        })
      ) {
        return false;
      }
      return expressionUsesAnySymbol({
        exprId: stmt.initializer,
        symbols,
        ctx,
        fnCtx,
      });
    case "expr-stmt":
      if (
        isSimpleIdentifierAliasAssignmentExpr({
          exprId: stmt.expr,
          symbols,
          ctx,
        })
      ) {
        return false;
      }
      return expressionUsesAnySymbol({
        exprId: stmt.expr,
        symbols,
        ctx,
        fnCtx,
      });
    case "return":
      return (
        typeof stmt.value === "number" &&
        expressionUsesAnySymbol({
          exprId: stmt.value,
          symbols,
          ctx,
          fnCtx,
        })
      );
    default:
      return false;
  }
};

const expressionUsesAnySymbol = ({
  exprId,
  symbols,
  ctx,
  fnCtx,
}: {
  exprId: number;
  symbols: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): boolean =>
  expressionUsesProjectedRootUnsafely({
    exprId,
    symbols,
    ctx,
    fnCtx,
  });

const isSimpleIdentifierAliasExpr = ({
  exprId,
  symbols,
  ctx,
}: {
  exprId: number;
  symbols: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  return expr?.exprKind === "identifier" && symbols.has(expr.symbol);
};

const isSimpleIdentifierAliasAssignmentExpr = ({
  exprId,
  symbols,
  ctx,
}: {
  exprId: number;
  symbols: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (
    expr?.exprKind !== "assign" ||
    !isSimpleIdentifierAliasExpr({
      exprId: expr.value,
      symbols,
      ctx,
    })
  ) {
    return false;
  }

  if (expr.pattern?.kind === "identifier") {
    return !symbols.has(expr.pattern.symbol);
  }

  if (typeof expr.target !== "number") {
    return false;
  }

  const targetExpr = ctx.module.hir.expressions.get(expr.target);
  return targetExpr?.exprKind === "identifier" && !symbols.has(targetExpr.symbol);
};

const collectSimpleIdentifierAliases = ({
  expr,
  ctx,
}: {
  expr: HirBlockExpr;
  ctx: CodegenContext;
}): Map<SymbolId, ReadonlySet<SymbolId>> => {
  const adjacency = new Map<SymbolId, Set<SymbolId>>();
  const link = (left: SymbolId, right: SymbolId): void => {
    if (left === right) {
      return;
    }
    const leftAliases = adjacency.get(left) ?? new Set<SymbolId>();
    leftAliases.add(right);
    adjacency.set(left, leftAliases);
    const rightAliases = adjacency.get(right) ?? new Set<SymbolId>();
    rightAliases.add(left);
    adjacency.set(right, rightAliases);
  };
  const maybeLinkIdentifierAlias = ({
    targetSymbol,
    valueExprId,
  }: {
    targetSymbol: SymbolId;
    valueExprId: number;
  }): void => {
    const valueExpr = ctx.module.hir.expressions.get(valueExprId);
    if (valueExpr?.exprKind === "identifier") {
      link(targetSymbol, valueExpr.symbol);
    }
  };

  expr.statements.forEach((stmtId) => {
    const stmt = ctx.module.hir.statements.get(stmtId);
    if (stmt?.kind === "let" && stmt.pattern.kind === "identifier") {
      maybeLinkIdentifierAlias({
        targetSymbol: stmt.pattern.symbol,
        valueExprId: stmt.initializer,
      });
    }
  });

  walkHirExpression({
    exprId: expr.id,
    ctx,
    visitor: {
      onExpr: (_exprId, node) => {
        if (node.exprKind !== "assign") {
          return;
        }
        if (typeof node.target === "number") {
          const targetExpr = ctx.module.hir.expressions.get(node.target);
          if (targetExpr?.exprKind === "identifier") {
            maybeLinkIdentifierAlias({
              targetSymbol: targetExpr.symbol,
              valueExprId: node.value,
            });
          }
        }
        if (node.pattern?.kind === "identifier") {
          maybeLinkIdentifierAlias({
            targetSymbol: node.pattern.symbol,
            valueExprId: node.value,
          });
        }
        return undefined;
      },
    },
  });

  const aliasSets = new Map<SymbolId, ReadonlySet<SymbolId>>();
  adjacency.forEach((_neighbors, symbol) => {
    if (aliasSets.has(symbol)) {
      return;
    }
    const component = new Set<SymbolId>();
    const queue = [symbol];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (component.has(current)) {
        continue;
      }
      component.add(current);
      (adjacency.get(current) ?? new Set<SymbolId>()).forEach((neighbor) => {
        queue.push(neighbor);
      });
    }
    component.forEach((member) => aliasSets.set(member, component));
  });

  return aliasSets;
};
