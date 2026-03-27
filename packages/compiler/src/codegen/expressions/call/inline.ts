import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  CompileCallOptions,
  ExpressionCompiler,
  FunctionContext,
  FunctionMetadata,
  HirFunction,
} from "../../context.js";
import { allocateTempLocal } from "../../locals.js";
import { walkHirExpression } from "../../hir-walk.js";
import { getSignatureSpillBoxType } from "../../types.js";

const INLINE_EXPR_LIMIT = 24;
const INLINE_STMT_LIMIT = 8;

const functionItemBySymbol = ({
  ctx,
  symbol,
}: {
  ctx: CodegenContext;
  symbol: number;
}): HirFunction | undefined =>
  Array.from(ctx.module.hir.items.values()).find(
    (item): item is HirFunction => item.kind === "function" && item.symbol === symbol,
  );

const isInlineCandidate = ({
  ownerCtx,
  fn,
  meta,
  callerFnCtx,
}: {
  ownerCtx: CodegenContext;
  fn: HirFunction;
  meta: FunctionMetadata;
  callerFnCtx: FunctionContext;
}): boolean => {
  if (meta.effectful) {
    return false;
  }
  if (
    meta.paramTypeIds.some((typeId) =>
      typeof typeId === "number" &&
      typeof getSignatureSpillBoxType({ typeId, ctx: ownerCtx }) === "number",
    ) ||
    typeof getSignatureSpillBoxType({
      typeId: meta.resultTypeId,
      ctx: ownerCtx,
    }) === "number"
  ) {
    return false;
  }
  if (callerFnCtx.inliningStack?.includes(meta.instanceId)) {
    return false;
  }
  if (fn.parameters.some((parameter) => typeof parameter.defaultValue === "number")) {
    return false;
  }

  let exprCount = 0;
  let stmtCount = 0;
  let allowed = true;

  walkHirExpression({
    exprId: fn.body,
    ctx: ownerCtx,
    visitLambdaBodies: true,
    visitHandlerBodies: true,
    visitor: {
      onExpr: (_exprId, expr) => {
        exprCount += 1;
        if (exprCount > INLINE_EXPR_LIMIT) {
          allowed = false;
          return "stop";
        }

        switch (expr.exprKind) {
          case "literal":
          case "identifier":
          case "call":
          case "method-call":
          case "block":
          case "tuple":
          case "cond":
          case "if":
          case "object-literal":
          case "field-access":
            return;
          default:
            allowed = false;
            return "stop";
        }
      },
      onStmt: (_stmtId, stmt) => {
        stmtCount += 1;
        if (stmtCount > INLINE_STMT_LIMIT) {
          allowed = false;
          return "stop";
        }
        if (stmt.kind === "return") {
          allowed = false;
          return "stop";
        }
        return;
      },
    },
  });

  return allowed;
};

export const tryInlineResolvedCall = ({
  meta,
  args,
  ctx,
  fnCtx,
  compileExpr,
  options = {},
}: {
  meta: FunctionMetadata;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  options?: CompileCallOptions;
}): CompiledExpression | undefined => {
  if (!ctx.optimization) {
    return undefined;
  }

  const ownerCtx = ctx.moduleContexts.get(meta.moduleId);
  if (!ownerCtx) {
    return undefined;
  }
  const fn = functionItemBySymbol({ ctx: ownerCtx, symbol: meta.symbol });
  if (!fn) {
    return undefined;
  }
  if (!isInlineCandidate({ ownerCtx, fn, meta, callerFnCtx: fnCtx })) {
    return undefined;
  }

  const inlineFnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals: fnCtx.locals,
    nextLocalIndex: fnCtx.nextLocalIndex,
    inliningStack: [...(fnCtx.inliningStack ?? []), meta.instanceId],
    returnTypeId: meta.resultTypeId,
    returnWasmType: meta.resultType,
    instanceId: meta.instanceId,
    typeInstanceId: meta.instanceId,
    effectful: false,
  };

  const setupOps = args.map((arg, index) => {
    const local = allocateTempLocal(
      meta.paramTypes[index] as binaryen.Type,
      inlineFnCtx,
      meta.paramTypeIds[index],
    );
    inlineFnCtx.bindings.set(fn.parameters[index]!.symbol, {
      ...local,
      kind: "local",
      typeId: meta.paramTypeIds[index],
    });
    return ownerCtx.mod.local.set(local.index, arg);
  });

  const body = compileExpr({
    exprId: fn.body,
    ctx: ownerCtx,
    fnCtx: inlineFnCtx,
    expectedResultTypeId: options.expectedResultTypeId,
  });
  fnCtx.nextLocalIndex = inlineFnCtx.nextLocalIndex;

  return {
    expr:
      setupOps.length === 0
        ? body.expr
        : ownerCtx.mod.block(
            null,
            [...setupOps, body.expr],
            binaryen.getExpressionType(body.expr),
          ),
    usedReturnCall: false,
  };
};
