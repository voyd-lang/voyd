import binaryen from "binaryen";
import {
  arrayGet,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirBlockExpr,
  HirCallExpr,
  HirExpression,
  HirExprId,
  HirPattern,
  HirMethodCallExpr,
  HirWhileExpr,
  SafeArrayLoopScope,
  StructuralFieldInfo,
  StructuralTypeInfo,
  SymbolId,
  TypeId,
} from "../context.js";
import { allocateLoopLabels, withLoopScope } from "../control-flow-stack.js";
import { withStableFieldLoadForwarding } from "../expressions/control-flow.js";
import { walkHirExpression } from "../hir-walk.js";
import {
  allocateTempLocal,
  loadLocalValue,
  storeLocalValue,
} from "../locals.js";
import {
  coerceValueToType,
  fixedArrayStorageElementType,
  liftFixedArrayElementValue,
  liftHeapValueToInline,
} from "../structural.js";
import {
  getExprBinaryenType,
  getMatchPatternTypeId,
  getRequiredExprType,
  getStructuralTypeInfo,
  wasmTypeFor,
} from "../types.js";
import { compilePatternInitializationFromValue } from "../patterns.js";
import { coerceExprToWasmType } from "../wasm-type-coercions.js";
import {
  isStdIntrinsicNominalType,
  isStdIntrinsicNominalTypeInstantiation,
  STD_INTRINSIC_TYPE,
} from "../../compiler-contracts/types.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import type { ArrayLoopProofFallbackReason } from "../../perf-counter-schema.js";

type ArrayMethodInfo = {
  targetTypeId: TypeId;
  structInfo: StructuralTypeInfo;
  storageField: StructuralFieldInfo;
  countField: StructuralFieldInfo;
};

type SafeArrayWhileLoopAnalysis = {
  scope: SafeArrayLoopScope;
  whileExpr: HirWhileExpr;
  cachedLengthExpr?: HirExprId;
};

type RangeForLoopAnalysis = {
  whileExpr: HirWhileExpr;
  startExpr: HirExprId;
  endExpr: HirExprId;
  includeEnd: boolean;
  indexSymbol: SymbolId;
  userBodyExpr: HirExprId;
  userStatements: readonly number[];
  safeArrayScope?: SafeArrayLoopScope;
};

type ArrayForLoopAnalysis = {
  whileExpr: HirWhileExpr;
  arrayExpr: HirExprId;
  arrayTypeId: TypeId;
  arrayInfo: ArrayMethodInfo;
  elementTypeId: TypeId;
  elementPattern: HirPattern;
  userStatements: readonly number[];
};

type StatementCompiler = (stmtId: number) => binaryen.ExpressionRef;

type ArrayLoopProofDecision =
  | { accepted: true }
  | { accepted: false; reason: ArrayLoopProofFallbackReason };

type SafeArrayWhileLoopDecision =
  | { kind: "not-candidate" }
  | { kind: "fallback"; reason: "shape" | ArrayLoopProofFallbackReason }
  | { kind: "accepted"; analysis: SafeArrayWhileLoopAnalysis };

type FastPathMetricPrefix =
  | "codegen.safe_array_while"
  | "codegen.range_array_safe_scope"
  | "codegen.intrinsic_array_for"
  | "codegen.intrinsic_range_for";

type FastPathFallbackReason =
  | ArrayLoopProofFallbackReason
  | "effectful"
  | "shape";

const recordFastPathDecision = ({
  prefix,
  accepted,
  reason,
}: {
  prefix: FastPathMetricPrefix;
  accepted: boolean;
  reason?: FastPathFallbackReason;
}): void => {
  incrementCompilerPerfCounter(`${prefix}.requested`);
  incrementCompilerPerfCounter(
    accepted ? `${prefix}.accepted` : `${prefix}.fallback.${reason ?? "shape"}`,
  );
};

const isStdArrayType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): boolean =>
  isStdIntrinsicNominalType({
    program: ctx.program,
    typeId,
    intrinsicType: STD_INTRINSIC_TYPE.array,
  });

const arrayMethodInfo = ({
  expr,
  ctx,
  fnCtx,
}: {
  expr: HirMethodCallExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): ArrayMethodInfo | undefined => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const targetTypeId = getRequiredExprType(expr.target, ctx, typeInstanceId);
  if (!isStdArrayType({ typeId: targetTypeId, ctx })) {
    return undefined;
  }

  const structInfo = getStructuralTypeInfo(targetTypeId, ctx);
  const storageField = structInfo?.fieldMap.get("storage");
  const countField = structInfo?.fieldMap.get("count");
  if (!structInfo || !storageField || !countField) {
    return undefined;
  }

  return { targetTypeId, structInfo, storageField, countField };
};

const directArrayFieldLoad = ({
  target,
  structInfo,
  field,
  ctx,
  fnCtx,
}: {
  target: () => binaryen.ExpressionRef;
  structInfo: StructuralTypeInfo;
  field: StructuralFieldInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef =>
  liftHeapValueToInline({
    value: structGetFieldValue({
      mod: ctx.mod,
      fieldType: field.heapWasmType,
      fieldIndex: field.runtimeIndex,
      exprRef: coerceExprToWasmType({
        expr: target(),
        targetType: structInfo.runtimeType,
        ctx,
      }),
    }),
    typeId: field.typeId,
    ctx,
    fnCtx,
  });

const compileArrayTarget = ({
  expr,
  info,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirMethodCallExpr;
  info: ArrayMethodInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}) => {
  const targetLocal = allocateTempLocal(
    wasmTypeFor(info.targetTypeId, ctx),
    fnCtx,
    info.targetTypeId,
    ctx,
  );
  const setup = storeLocalValue({
    binding: targetLocal,
    value: compileExpr({
      exprId: expr.target,
      ctx,
      fnCtx,
      expectedResultTypeId: info.targetTypeId,
    }).expr,
    ctx,
    fnCtx,
  });
  return {
    setup,
    target: () => loadLocalValue(targetLocal, ctx),
  };
};

const expressionSymbol = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): SymbolId | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  return expr?.exprKind === "identifier" ? expr.symbol : undefined;
};

const isLiteralI32 = ({
  exprId,
  value,
  ctx,
}: {
  exprId: HirExprId;
  value: string;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  return (
    expr?.exprKind === "literal" &&
    expr.literalKind === "i32" &&
    expr.value === value
  );
};

const callHasName = ({
  expr,
  name,
  ctx,
  allowSourceName = false,
}: {
  expr: HirCallExpr;
  name: string;
  ctx: CodegenContext;
  allowSourceName?: boolean;
}): boolean => {
  const intrinsicName = callIntrinsicName({ expr, ctx });
  const callee = ctx.module.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return false;
  }
  const calleeId = ctx.program.symbols.canonicalIdOf(
    ctx.moduleId,
    callee.symbol,
  );
  return (
    intrinsicName === name ||
    (allowSourceName && ctx.program.symbols.getName(calleeId) === name)
  );
};

const callIntrinsicName = ({
  expr,
  ctx,
}: {
  expr: HirCallExpr;
  ctx: CodegenContext;
}): string | undefined => {
  const callee = ctx.module.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return undefined;
  }
  const calleeId = ctx.program.symbols.canonicalIdOf(
    ctx.moduleId,
    callee.symbol,
  );
  const intrinsicName = ctx.program.symbols.getIntrinsicName(calleeId);
  if (typeof intrinsicName === "string") {
    return intrinsicName;
  }
  const intrinsicFlags =
    ctx.program.symbols.getIntrinsicFunctionFlags(calleeId);
  return intrinsicFlags.intrinsic
    ? ctx.program.symbols.getName(calleeId)
    : undefined;
};

const isCallNamed = ({
  expr,
  name,
  ctx,
  allowSourceName,
}: {
  expr: HirExpression;
  name: string;
  ctx: CodegenContext;
  allowSourceName?: boolean;
}): boolean =>
  expr.exprKind === "call" && callHasName({ expr, name, ctx, allowSourceName });

const parseArrayLenExpr = ({
  exprId,
  ctx,
  fnCtx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): { arraySymbol: SymbolId; expr: HirMethodCallExpr } | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (
    expr?.exprKind !== "method-call" ||
    expr.method !== "len" ||
    expr.args.length !== 0 ||
    !arrayMethodInfo({ expr, ctx, fnCtx })
  ) {
    return undefined;
  }

  const arraySymbol = expressionSymbol({ exprId: expr.target, ctx });
  return typeof arraySymbol === "number" ? { arraySymbol, expr } : undefined;
};

const aliasesFor = ({
  symbol,
  fnCtx,
}: {
  symbol: SymbolId;
  fnCtx: FunctionContext;
}): ReadonlySet<SymbolId> =>
  fnCtx.simpleIdentifierAliases?.get(symbol) ?? new Set([symbol]);

const exprIsIndexIncrement = ({
  exprId,
  indexSymbol,
  ctx,
}: {
  exprId: HirExprId;
  indexSymbol: SymbolId;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (
    !expr ||
    expr.exprKind !== "call" ||
    !isCallNamed({ expr, name: "+", ctx }) ||
    expr.args.length !== 2
  ) {
    return false;
  }

  const [left, right] = expr.args;
  const leftSymbol = left
    ? expressionSymbol({ exprId: left.expr, ctx })
    : undefined;
  const rightSymbol = right
    ? expressionSymbol({ exprId: right.expr, ctx })
    : undefined;

  return (
    (leftSymbol === indexSymbol &&
      Boolean(
        right && isLiteralI32({ exprId: right.expr, value: "1", ctx }),
      )) ||
    (rightSymbol === indexSymbol &&
      Boolean(left && isLiteralI32({ exprId: left.expr, value: "1", ctx })))
  );
};

const targetIdentifierSymbol = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId | undefined;
  ctx: CodegenContext;
}): SymbolId | undefined =>
  typeof exprId === "number" ? expressionSymbol({ exprId, ctx }) : undefined;

const isSafeArrayLoopRead = ({
  expr,
  indexSymbol,
  ctx,
}: {
  expr: HirMethodCallExpr;
  indexSymbol: SymbolId;
  ctx: CodegenContext;
}): boolean => {
  if (expr.method === "len" && expr.args.length === 0) {
    return true;
  }
  if (
    (expr.method !== "at" && expr.method !== "get") ||
    expr.args.length !== 1
  ) {
    return false;
  }
  return expressionSymbol({ exprId: expr.args[0]!.expr, ctx }) === indexSymbol;
};

const safeLoopIntrinsicCalls = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "and",
  "or",
  "xor",
  "not",
]);

const isSafeLoopIntrinsicCall = ({
  expr,
  ctx,
  fnCtx,
}: {
  expr: HirCallExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): boolean => {
  const callee = ctx.module.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return false;
  }
  const calleeId = ctx.program.symbols.canonicalIdOf(
    ctx.moduleId,
    callee.symbol,
  );
  const callName =
    ctx.program.symbols.getIntrinsicName(calleeId) ??
    ctx.program.symbols.getName(calleeId);
  if (typeof callName !== "string" || !safeLoopIntrinsicCalls.has(callName)) {
    return false;
  }
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  return (
    isSafeLoopPrimitiveType({
      typeId: getRequiredExprType(expr.id, ctx, typeInstanceId),
      ctx,
    }) &&
    expr.args.every((arg) =>
      isSafeLoopPrimitiveType({
        typeId: getRequiredExprType(arg.expr, ctx, typeInstanceId),
        ctx,
      }),
    )
  );
};

const safeLoopResolvedCallDecision = ({
  expr,
  ctx,
}: {
  expr: HirCallExpr;
  ctx: CodegenContext;
}): ArrayLoopProofDecision => {
  const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, expr.id);
  if (callInfo.traitDispatch) {
    return { accepted: false, reason: "dynamic-call" };
  }
  if (callInfo.identityGuards.length > 0) {
    return { accepted: false, reason: "identity-guard" };
  }
  const targets = [...(callInfo.targets?.values() ?? [])];
  if (targets.length === 0) {
    const callee = ctx.module.hir.expressions.get(expr.callee);
    const target =
      callee?.exprKind === "identifier"
        ? ctx.program.functions.getFunctionId({
            moduleId: ctx.moduleId,
            symbol: callee.symbol,
          })
        : undefined;
    if (typeof target !== "number") {
      return { accepted: false, reason: "unresolved-call" };
    }
    targets.push(target);
  }
  for (const target of targets) {
    const summary = ctx.program.ordinaryMutations.getSummary(target);
    if (!summary) return { accepted: false, reason: "missing-summary" };
    if (summary.maySuspend) {
      return { accepted: false, reason: "suspending-call" };
    }
    if (summary.ambientObjectAccess) {
      return { accepted: false, reason: "ambient-access" };
    }
    if (summary.invokesUnknownCallback) {
      return { accepted: false, reason: "unknown-callback" };
    }
    if (summary.parameterAccesses.some((access) => access === "write")) {
      return { accepted: false, reason: "parameter-write" };
    }
  }
  return { accepted: true };
};

const isSafeLoopPrimitiveType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): boolean =>
  typeId === ctx.program.primitives.bool ||
  typeId === ctx.program.primitives.i32 ||
  typeId === ctx.program.primitives.i64 ||
  typeId === ctx.program.primitives.f32 ||
  typeId === ctx.program.primitives.f64;

const isIndexIncrementAssignment = ({
  exprId,
  indexSymbol,
  ctx,
}: {
  exprId: HirExprId;
  indexSymbol: SymbolId;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (expr?.exprKind !== "assign") {
    return false;
  }
  const targetSymbol = targetIdentifierSymbol({
    exprId: expr.target,
    ctx,
  });
  return (
    targetSymbol === indexSymbol &&
    exprIsIndexIncrement({ exprId: expr.value, indexSymbol, ctx })
  );
};

const bodyHasFinalIndexIncrement = ({
  bodyExprId,
  indexSymbol,
  ctx,
}: {
  bodyExprId: HirExprId;
  indexSymbol: SymbolId;
  ctx: CodegenContext;
}): boolean => {
  const body = ctx.module.hir.expressions.get(bodyExprId);
  if (body?.exprKind !== "block" || body.statements.length === 0) {
    return false;
  }
  if (typeof body.value === "number") {
    return isIndexIncrementAssignment({
      exprId: body.value,
      indexSymbol,
      ctx,
    });
  }
  const lastStatementId = body.statements.at(-1);
  const lastStatement =
    typeof lastStatementId === "number"
      ? ctx.module.hir.statements.get(lastStatementId)
      : undefined;
  return (
    lastStatement?.kind === "expr-stmt" &&
    isIndexIncrementAssignment({
      exprId: lastStatement.expr,
      indexSymbol,
      ctx,
    })
  );
};

const bodyPreservesArrayLoopProof = ({
  bodyExprId,
  indexSymbol,
  arraySymbol,
  indexUpdate,
  ctx,
  fnCtx,
}: {
  bodyExprId: HirExprId;
  indexSymbol: SymbolId;
  arraySymbol: SymbolId;
  indexUpdate: "increment" | "none";
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): ArrayLoopProofDecision => {
  const arrayAliases = aliasesFor({ symbol: arraySymbol, fnCtx });
  let indexIncrements = 0;
  let fallback: ArrayLoopProofFallbackReason | undefined;
  const reject = (reason: ArrayLoopProofFallbackReason): void => {
    fallback ??= reason;
  };

  walkHirExpression({
    exprId: bodyExprId,
    ctx,
    visitor: {
      onExpr: (exprId, expr) => {
        if (fallback) {
          return "stop";
        }
        if (
          exprId !== bodyExprId &&
          (expr.exprKind === "while" || expr.exprKind === "loop")
        ) {
          reject("nested-control");
          return "stop";
        }
        if (expr.exprKind === "break" || expr.exprKind === "continue") {
          reject("control-transfer");
          return "stop";
        }
        if (expr.exprKind === "assign") {
          const targetSymbol = targetIdentifierSymbol({
            exprId: expr.target,
            ctx,
          });
          if (
            typeof targetSymbol === "number" &&
            arrayAliases.has(targetSymbol)
          ) {
            reject("array-reassigned");
            return "stop";
          }
          if (targetSymbol === indexSymbol) {
            if (
              !exprIsIndexIncrement({ exprId: expr.value, indexSymbol, ctx })
            ) {
              reject("index-update");
              return "stop";
            }
            indexIncrements += 1;
          }
          return undefined;
        }
        if (expr.exprKind === "method-call") {
          const targetSymbol = expressionSymbol({ exprId: expr.target, ctx });
          if (
            typeof targetSymbol === "number" &&
            arrayAliases.has(targetSymbol) &&
            isSafeArrayLoopRead({ expr, indexSymbol, ctx })
          ) {
            return undefined;
          }
          reject("array-method");
          return "stop";
        }
        if (expr.exprKind === "call") {
          if (!isSafeLoopIntrinsicCall({ expr, ctx, fnCtx })) {
            const decision = safeLoopResolvedCallDecision({ expr, ctx });
            if (!decision.accepted) {
              reject(decision.reason);
              return "stop";
            }
          }
          if (
            expr.args.some((arg) => {
              const argSymbol = expressionSymbol({ exprId: arg.expr, ctx });
              return (
                typeof argSymbol === "number" && arrayAliases.has(argSymbol)
              );
            })
          ) {
            reject("array-alias-argument");
            return "stop";
          }
        }
        return undefined;
      },
    },
  });
  if (fallback) return { accepted: false, reason: fallback };
  return indexIncrements === (indexUpdate === "increment" ? 1 : 0)
    ? { accepted: true }
    : { accepted: false, reason: "index-count" };
};

const indexInitStatement = ({
  block,
  statementIndex,
  indexSymbol,
  ctx,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  indexSymbol: SymbolId;
  ctx: CodegenContext;
}): { statementIndex: number; indexSymbol: SymbolId } | undefined => {
  for (let index = statementIndex - 1; index >= 0; index -= 1) {
    const stmt = ctx.module.hir.statements.get(block.statements[index]!);
    if (stmt?.kind !== "let") {
      return undefined;
    }
    if (
      stmt.mutable &&
      stmt.pattern.kind === "identifier" &&
      stmt.pattern.symbol === indexSymbol
    ) {
      return isLiteralI32({ exprId: stmt.initializer, value: "0", ctx })
        ? { statementIndex: index, indexSymbol }
        : undefined;
    }
  }
  return undefined;
};

const lengthLetStatement = ({
  block,
  statementIndex,
  lengthSymbol,
  ctx,
  fnCtx,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  lengthSymbol: SymbolId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): { arraySymbol: SymbolId } | undefined => {
  for (let index = statementIndex - 1; index >= 0; index -= 1) {
    const stmt = ctx.module.hir.statements.get(block.statements[index]!);
    if (stmt?.kind !== "let") {
      return undefined;
    }
    if (
      !stmt.mutable &&
      stmt.pattern.kind === "identifier" &&
      stmt.pattern.symbol === lengthSymbol
    ) {
      return parseArrayLenExpr({
        exprId: stmt.initializer,
        ctx,
        fnCtx,
      });
    }
  }
  return undefined;
};

export const arrayLengthBindingForStatement = ({
  stmtId,
  ctx,
  fnCtx,
}: {
  stmtId: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): { lengthSymbol: SymbolId; arraySymbol: SymbolId } | undefined => {
  const stmt = ctx.module.hir.statements.get(stmtId);
  if (
    stmt?.kind !== "let" ||
    stmt.mutable ||
    stmt.pattern.kind !== "identifier"
  ) {
    return undefined;
  }
  const length = parseArrayLenExpr({
    exprId: stmt.initializer,
    ctx,
    fnCtx,
  });
  return length
    ? {
        lengthSymbol: stmt.pattern.symbol,
        arraySymbol: length.arraySymbol,
      }
    : undefined;
};

const analyzeWhileCondition = ({
  expr,
  block,
  statementIndex,
  ctx,
  fnCtx,
}: {
  expr: HirWhileExpr;
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}):
  | {
      indexSymbol: SymbolId;
      arraySymbol: SymbolId;
      cachedLengthExpr?: HirExprId;
    }
  | undefined => {
  const condition = ctx.module.hir.expressions.get(expr.condition);
  if (
    !condition ||
    condition.exprKind !== "call" ||
    !isCallNamed({ expr: condition, name: "<", ctx })
  ) {
    return undefined;
  }
  const [left, right] = condition.args;
  if (!left || !right) {
    return undefined;
  }
  const indexSymbol = expressionSymbol({ exprId: left.expr, ctx });
  if (typeof indexSymbol !== "number") {
    return undefined;
  }

  const directLength = parseArrayLenExpr({
    exprId: right.expr,
    ctx,
    fnCtx,
  });
  if (directLength) {
    return {
      indexSymbol,
      arraySymbol: directLength.arraySymbol,
      cachedLengthExpr: right.expr,
    };
  }

  const lengthSymbol = expressionSymbol({ exprId: right.expr, ctx });
  if (typeof lengthSymbol !== "number") {
    return undefined;
  }
  const length = lengthLetStatement({
    block,
    statementIndex,
    lengthSymbol,
    ctx,
    fnCtx,
  });
  const scopedArraySymbol = fnCtx.safeArrayLengthSymbols?.get(lengthSymbol);
  return length
    ? {
        indexSymbol,
        arraySymbol: length.arraySymbol,
      }
    : typeof scopedArraySymbol === "number"
      ? {
          indexSymbol,
          arraySymbol: scopedArraySymbol,
        }
      : undefined;
};

const tryAnalyzeSafeArrayWhileLoop = ({
  block,
  statementIndex,
  ctx,
  fnCtx,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): SafeArrayWhileLoopDecision => {
  const currentStmtId = block.statements[statementIndex];
  const currentStmt =
    typeof currentStmtId === "number"
      ? ctx.module.hir.statements.get(currentStmtId)
      : undefined;
  if (currentStmt?.kind !== "expr-stmt") {
    return { kind: "not-candidate" };
  }
  const whileExpr = ctx.module.hir.expressions.get(currentStmt.expr);
  if (whileExpr?.exprKind !== "while") {
    return { kind: "not-candidate" };
  }

  const condition = analyzeWhileCondition({
    expr: whileExpr,
    block,
    statementIndex,
    ctx,
    fnCtx,
  });
  if (!condition) {
    return { kind: "fallback", reason: "shape" };
  }

  const indexInit = indexInitStatement({
    block,
    statementIndex,
    indexSymbol: condition.indexSymbol,
    ctx,
  });
  if (!indexInit) {
    return { kind: "fallback", reason: "shape" };
  }
  if (
    !bodyHasFinalIndexIncrement({
      bodyExprId: whileExpr.body,
      indexSymbol: indexInit.indexSymbol,
      ctx,
    })
  ) {
    return { kind: "fallback", reason: "shape" };
  }

  const proof = bodyPreservesArrayLoopProof({
    bodyExprId: whileExpr.body,
    indexSymbol: indexInit.indexSymbol,
    arraySymbol: condition.arraySymbol,
    indexUpdate: "increment",
    ctx,
    fnCtx,
  });
  if (!proof.accepted) {
    return { kind: "fallback", reason: proof.reason };
  }

  return {
    kind: "accepted",
    analysis: {
      whileExpr,
      scope: {
        arraySymbol: condition.arraySymbol,
        indexSymbol: indexInit.indexSymbol,
      },
      cachedLengthExpr: condition.cachedLengthExpr,
    },
  };
};

const loadI32Local = ({
  symbol,
  ctx,
  fnCtx,
}: {
  symbol: SymbolId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef | undefined => {
  const binding = fnCtx.bindings.get(symbol);
  if (!binding || binding.kind !== "local") {
    return undefined;
  }
  const value = loadLocalValue(binding, ctx);
  return binaryen.getExpressionType(value) === binaryen.i32 ? value : undefined;
};

const withSafeArrayLoopScope = <T>({
  scope,
  fnCtx,
  run,
}: {
  scope: SafeArrayLoopScope;
  fnCtx: FunctionContext;
  run: () => T;
}): T => {
  const previousScopes = fnCtx.safeArrayLoopScopes;
  fnCtx.safeArrayLoopScopes = [...(previousScopes ?? []), scope];
  try {
    return run();
  } finally {
    fnCtx.safeArrayLoopScopes = previousScopes;
  }
};

const compileSafeArrayWhileLoop = ({
  analysis,
  ctx,
  fnCtx,
  compileExpr,
}: {
  analysis: SafeArrayWhileLoopAnalysis;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef | undefined => {
  const { loopLabel, breakLabel } = allocateLoopLabels({
    fnCtx,
    prefix: `array_safe_while_loop_${analysis.whileExpr.id}`,
  });
  const setup: binaryen.ExpressionRef[] = [];
  let conditionExpr: binaryen.ExpressionRef | undefined;
  if (typeof analysis.cachedLengthExpr === "number") {
    const lengthLocal = allocateTempLocal(binaryen.i32, fnCtx);
    const indexValue = loadI32Local({
      symbol: analysis.scope.indexSymbol,
      ctx,
      fnCtx,
    });
    if (typeof indexValue !== "number") {
      return undefined;
    }
    setup.push(
      ctx.mod.local.set(
        lengthLocal.index,
        compileExpr({
          exprId: analysis.cachedLengthExpr,
          ctx,
          fnCtx,
          expectedResultTypeId: ctx.program.primitives.i32,
        }).expr,
      ),
    );
    conditionExpr = ctx.mod.i32.lt_s(
      indexValue,
      ctx.mod.local.get(lengthLocal.index, binaryen.i32),
    );
  } else {
    conditionExpr = compileExpr({
      exprId: analysis.whileExpr.condition,
      ctx,
      fnCtx,
    }).expr;
  }

  const conditionCheck = ctx.mod.if(
    ctx.mod.i32.eqz(conditionExpr),
    ctx.mod.br(breakLabel),
  );
  const body = withSafeArrayLoopScope({
    scope: analysis.scope,
    fnCtx,
    run: () =>
      withLoopScope(
        fnCtx,
        { breakLabel, continueLabel: loopLabel },
        () =>
          compileExpr({
            exprId: analysis.whileExpr.body,
            ctx,
            fnCtx,
          }).expr,
      ),
  });
  const loopBody = ctx.mod.block(
    null,
    [conditionCheck, body, ctx.mod.br(loopLabel)],
    binaryen.none,
  );

  return ctx.mod.block(
    breakLabel,
    [...setup, ctx.mod.loop(loopLabel, loopBody)],
    binaryen.none,
  );
};

export const tryCompileArraySafeWhileStatement = ({
  block,
  statementIndex,
  ctx,
  fnCtx,
  compileExpr,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef | undefined => {
  const decision = tryAnalyzeSafeArrayWhileLoop({
    block,
    statementIndex,
    ctx,
    fnCtx,
  });
  if (decision.kind === "not-candidate") {
    return undefined;
  }
  recordFastPathDecision({
    prefix: "codegen.safe_array_while",
    accepted: decision.kind === "accepted",
    ...(decision.kind === "fallback" ? { reason: decision.reason } : {}),
  });
  if (decision.kind === "fallback") return undefined;
  return compileSafeArrayWhileLoop({
    analysis: decision.analysis,
    ctx,
    fnCtx,
    compileExpr,
  });
};

const patternTypeName = (pattern: HirPattern): string | undefined => {
  if (pattern.kind !== "type" || pattern.type.typeKind !== "named") {
    return undefined;
  }
  return pattern.type.path.at(-1);
};

const isStdIntrinsicTypePattern = ({
  pattern,
  intrinsicType,
  ctx,
}: {
  pattern: HirPattern;
  intrinsicType:
    | typeof STD_INTRINSIC_TYPE.optionalSome
    | typeof STD_INTRINSIC_TYPE.optionalNone;
  ctx: CodegenContext;
}): boolean =>
  pattern.kind === "type" &&
  isStdIntrinsicNominalType({
    program: ctx.program,
    typeId: getMatchPatternTypeId(pattern, ctx),
    intrinsicType,
  });

const isVoidLiteral = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  return expr?.exprKind === "literal" && expr.literalKind === "void";
};

export const isCanonicalStdTraitMethodCall = ({
  expr,
  traitName,
  methodName,
  allowExternalImplementations = false,
  ctx,
}: {
  expr: HirMethodCallExpr;
  traitName: "Sequence" | "Iterator";
  methodName: "iter" | "next";
  allowExternalImplementations?: boolean;
  ctx: CodegenContext;
}): boolean => {
  if (
    expr.method !== methodName ||
    expr.args.length !== 0 ||
    ctx.program.calls.getCallInfo(ctx.moduleId, expr.id).identityGuards.length >
      0
  ) {
    return false;
  }
  const targets = new Set(
    ctx.program.calls.getCallInfo(ctx.moduleId, expr.id).targets?.values() ??
      [],
  );
  if (targets.size !== 1) {
    return false;
  }
  return [...targets].every((target) => {
    const traitMethod = ctx.program.traits.getTraitMethodImpl(target);
    return (
      (allowExternalImplementations ||
        (ctx.program.symbols.getPackageId(target) === "std" &&
          ctx.program.symbols.getName(target) === methodName)) &&
      traitMethod !== undefined &&
      ctx.program.symbols.getPackageId(traitMethod.traitSymbol) === "std" &&
      ctx.program.symbols.getName(traitMethod.traitSymbol) === traitName &&
      ctx.program.symbols.getPackageId(traitMethod.traitMethodSymbol) ===
        "std" &&
      ctx.program.symbols.getName(traitMethod.traitMethodSymbol) === methodName
    );
  });
};

const parseArrayForIterator = ({
  initializer,
  ctx,
  fnCtx,
}: {
  initializer: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}):
  | {
      arrayExpr: HirExprId;
      arrayTypeId: TypeId;
      arrayInfo: ArrayMethodInfo;
      elementTypeId: TypeId;
    }
  | undefined => {
  const iterCall = ctx.module.hir.expressions.get(initializer);
  if (
    iterCall?.exprKind !== "method-call" ||
    !isCanonicalStdTraitMethodCall({
      expr: iterCall,
      traitName: "Sequence",
      methodName: "iter",
      ctx,
    })
  ) {
    return undefined;
  }
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const arrayTypeId = getRequiredExprType(iterCall.target, ctx, typeInstanceId);
  if (!isStdArrayType({ typeId: arrayTypeId, ctx })) {
    return undefined;
  }
  const structInfo = getStructuralTypeInfo(arrayTypeId, ctx);
  const storageField = structInfo?.fieldMap.get("storage");
  const countField = structInfo?.fieldMap.get("count");
  if (!structInfo || !storageField || !countField) {
    return undefined;
  }
  const storageDesc = ctx.program.types.getTypeDesc(storageField.typeId);
  if (storageDesc.kind !== "fixed-array") {
    return undefined;
  }
  return {
    arrayExpr: iterCall.target,
    arrayTypeId,
    arrayInfo: {
      targetTypeId: arrayTypeId,
      structInfo,
      storageField,
      countField,
    },
    elementTypeId: storageDesc.element,
  };
};

export const parseCanonicalStdForBody = ({
  whileExpr,
  iteratorSymbol,
  allowExternalImplementations = false,
  ctx,
}: {
  whileExpr: HirWhileExpr;
  iteratorSymbol: SymbolId;
  allowExternalImplementations?: boolean;
  ctx: CodegenContext;
}):
  | {
      elementPattern: HirPattern;
      userStatements: readonly number[];
      nextCall: HirMethodCallExpr;
    }
  | undefined => {
  if (!isLiteralBoolean({ exprId: whileExpr.condition, value: "true", ctx })) {
    return undefined;
  }
  const body = ctx.module.hir.expressions.get(whileExpr.body);
  if (body?.exprKind !== "block" || body.statements.length !== 1) {
    return undefined;
  }
  const nextStmt = ctx.module.hir.statements.get(body.statements[0]!);
  if (
    nextStmt?.kind !== "let" ||
    nextStmt.mutable ||
    nextStmt.pattern.kind !== "identifier"
  ) {
    return undefined;
  }
  const nextValueSymbol = nextStmt.pattern.symbol;
  const nextCall = ctx.module.hir.expressions.get(nextStmt.initializer);
  if (
    nextCall?.exprKind !== "method-call" ||
    expressionSymbol({ exprId: nextCall.target, ctx }) !== iteratorSymbol ||
    !isCanonicalStdTraitMethodCall({
      expr: nextCall,
      traitName: "Iterator",
      methodName: "next",
      allowExternalImplementations,
      ctx,
    })
  ) {
    return undefined;
  }
  const match =
    typeof body.value === "number"
      ? ctx.module.hir.expressions.get(body.value)
      : undefined;
  if (
    match?.exprKind !== "match" ||
    match.arms.length !== 2 ||
    expressionSymbol({ exprId: match.discriminant, ctx }) !== nextValueSymbol
  ) {
    return undefined;
  }
  const [someArm, noneArm] = match.arms;
  if (
    !someArm ||
    !noneArm ||
    someArm.guard !== undefined ||
    noneArm.guard !== undefined ||
    someArm.pattern.kind !== "type" ||
    someArm.pattern.binding !== undefined ||
    !isStdIntrinsicTypePattern({
      pattern: someArm.pattern,
      intrinsicType: STD_INTRINSIC_TYPE.optionalSome,
      ctx,
    }) ||
    noneArm.pattern.kind !== "type" ||
    noneArm.pattern.binding !== undefined ||
    !isStdIntrinsicTypePattern({
      pattern: noneArm.pattern,
      intrinsicType: STD_INTRINSIC_TYPE.optionalNone,
      ctx,
    }) ||
    !isBreakBlock({ exprId: noneArm.value, ctx })
  ) {
    return undefined;
  }
  const someBlock = ctx.module.hir.expressions.get(someArm.value);
  if (
    someBlock?.exprKind !== "block" ||
    someBlock.statements.length === 0 ||
    typeof someBlock.value !== "number" ||
    !isVoidLiteral({ exprId: someBlock.value, ctx })
  ) {
    return undefined;
  }
  const elementStmt = ctx.module.hir.statements.get(someBlock.statements[0]!);
  if (elementStmt?.kind !== "let" || elementStmt.mutable) {
    return undefined;
  }
  const payload = ctx.module.hir.expressions.get(elementStmt.initializer);
  if (
    payload?.exprKind !== "field-access" ||
    payload.field !== "value" ||
    expressionSymbol({ exprId: payload.target, ctx }) !== nextValueSymbol
  ) {
    return undefined;
  }
  let usesMacroTemporary = false;
  walkHirExpression({
    exprId: someArm.value,
    ctx,
    visitor: {
      onExpr: (exprId, expr) => {
        if (
          expr.exprKind !== "identifier" ||
          (expr.symbol !== iteratorSymbol &&
            (expr.symbol !== nextValueSymbol || exprId === payload.target))
        ) {
          return;
        }
        usesMacroTemporary = true;
        return "stop";
      },
    },
  });
  if (usesMacroTemporary) {
    return undefined;
  }
  return {
    elementPattern: elementStmt.pattern,
    userStatements: someBlock.statements.slice(1),
    nextCall,
  };
};

const tryAnalyzeArrayForLoop = ({
  block,
  statementIndex,
  ctx,
  fnCtx,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): ArrayForLoopAnalysis | undefined => {
  const currentStmt = ctx.module.hir.statements.get(
    block.statements[statementIndex]!,
  );
  if (currentStmt?.kind !== "expr-stmt") {
    return undefined;
  }
  const wrapper = ctx.module.hir.expressions.get(currentStmt.expr);
  if (wrapper?.exprKind !== "block" || wrapper.statements.length !== 1) {
    return undefined;
  }
  const iteratorStmt = ctx.module.hir.statements.get(wrapper.statements[0]!);
  if (
    iteratorStmt?.kind !== "let" ||
    iteratorStmt.mutable ||
    iteratorStmt.pattern.kind !== "identifier"
  ) {
    return undefined;
  }
  const iterator = parseArrayForIterator({
    initializer: iteratorStmt.initializer,
    ctx,
    fnCtx,
  });
  const whileExpr =
    typeof wrapper.value === "number"
      ? ctx.module.hir.expressions.get(wrapper.value)
      : undefined;
  if (!iterator || whileExpr?.exprKind !== "while") {
    return undefined;
  }
  const body = parseCanonicalStdForBody({
    whileExpr,
    iteratorSymbol: iteratorStmt.pattern.symbol,
    ctx,
  });
  return body
    ? {
        whileExpr,
        ...iterator,
        ...body,
      }
    : undefined;
};

const forLoopIteratorCall = ({
  block,
  statementIndex,
  ctx,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
}): HirMethodCallExpr | undefined => {
  const statement = ctx.module.hir.statements.get(
    block.statements[statementIndex]!,
  );
  const wrapper =
    statement?.kind === "expr-stmt"
      ? ctx.module.hir.expressions.get(statement.expr)
      : undefined;
  const iteratorStatement =
    wrapper?.exprKind === "block" && wrapper.statements.length === 1
      ? ctx.module.hir.statements.get(wrapper.statements[0]!)
      : undefined;
  const iterCall =
    iteratorStatement?.kind === "let"
      ? ctx.module.hir.expressions.get(iteratorStatement.initializer)
      : undefined;
  const whileExpr =
    wrapper?.exprKind === "block" && typeof wrapper.value === "number"
      ? ctx.module.hir.expressions.get(wrapper.value)
      : undefined;
  return iteratorStatement?.kind === "let" &&
    iterCall?.exprKind === "method-call" &&
    whileExpr?.exprKind === "while"
    ? iterCall
    : undefined;
};

const intrinsicArrayForLoopCandidate = ({
  block,
  statementIndex,
  ctx,
  fnCtx,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): boolean => {
  const iterCall = forLoopIteratorCall({ block, statementIndex, ctx });
  if (!iterCall) return false;
  const typeId = getRequiredExprType(
    iterCall.target,
    ctx,
    fnCtx.typeInstanceId ?? fnCtx.instanceId,
  );
  return isStdArrayType({ typeId, ctx });
};

const intrinsicRangeForLoopCandidate = ({
  block,
  statementIndex,
  ctx,
  fnCtx,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): boolean => {
  const iterCall = forLoopIteratorCall({ block, statementIndex, ctx });
  if (!iterCall) return false;
  const typeId = getRequiredExprType(
    iterCall.target,
    ctx,
    fnCtx.typeInstanceId ?? fnCtx.instanceId,
  );
  return isStdIntrinsicNominalTypeInstantiation({
    program: ctx.program,
    typeId,
    intrinsicType: STD_INTRINSIC_TYPE.range,
    typeArgs: [ctx.program.primitives.i32],
  });
};

const compileArrayForLoop = ({
  analysis,
  ctx,
  fnCtx,
  compileExpr,
  compileStatement,
}: {
  analysis: ArrayForLoopAnalysis;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  compileStatement: StatementCompiler;
}): binaryen.ExpressionRef => {
  const { loopLabel, breakLabel } = allocateLoopLabels({
    fnCtx,
    prefix: "array_for_loop",
  });
  const arrayLocal = allocateTempLocal(
    wasmTypeFor(analysis.arrayTypeId, ctx),
    fnCtx,
    analysis.arrayTypeId,
    ctx,
  );
  const storageLocal = allocateTempLocal(
    wasmTypeFor(analysis.arrayInfo.storageField.typeId, ctx),
    fnCtx,
    analysis.arrayInfo.storageField.typeId,
    ctx,
  );
  const cursorLocal = allocateTempLocal(
    binaryen.i32,
    fnCtx,
    ctx.program.primitives.i32,
    ctx,
  );
  const array = () => loadLocalValue(arrayLocal, ctx);
  const storage = () => loadLocalValue(storageLocal, ctx);
  const cursor = () => ctx.mod.local.get(cursorLocal.index, binaryen.i32);
  const previousBindings = new Map(fnCtx.bindings);
  const { setup: forwardingStores, value: body } = (() => {
    try {
      return withStableFieldLoadForwarding({
        loopExprId: analysis.whileExpr.id,
        ctx,
        fnCtx,
        compileExpr,
        run: () => {
          const itemOps: binaryen.ExpressionRef[] = [];
          const item = liftFixedArrayElementValue({
            value: arrayGet(
              ctx.mod,
              storage(),
              cursor(),
              fixedArrayStorageElementType({
                typeId: analysis.elementTypeId,
                ctx,
              }),
              false,
            ),
            typeId: analysis.elementTypeId,
            ctx,
            fnCtx,
          });
          compilePatternInitializationFromValue({
            pattern: analysis.elementPattern,
            value: item,
            valueTypeId: analysis.elementTypeId,
            ctx,
            fnCtx,
            ops: itemOps,
            options: { declare: true },
          });
          const userBody = withLoopScope(
            fnCtx,
            { breakLabel, continueLabel: loopLabel },
            () =>
              ctx.mod.block(
                null,
                analysis.userStatements.map((stmtId) =>
                  compileStatement(stmtId),
                ),
                binaryen.none,
              ),
          );
          return ctx.mod.block(
            null,
            [
              ...itemOps,
              ctx.mod.local.set(
                cursorLocal.index,
                ctx.mod.i32.add(cursor(), ctx.mod.i32.const(1)),
              ),
              userBody,
            ],
            binaryen.none,
          );
        },
      });
    } finally {
      fnCtx.bindings = previousBindings;
    }
  })();
  const count = directArrayFieldLoad({
    target: array,
    structInfo: analysis.arrayInfo.structInfo,
    field: analysis.arrayInfo.countField,
    ctx,
    fnCtx,
  });
  const conditionCheck = ctx.mod.if(
    ctx.mod.i32.ge_s(cursor(), count),
    ctx.mod.br(breakLabel),
  );
  const loadStorage = storeLocalValue({
    binding: storageLocal,
    value: directArrayFieldLoad({
      target: array,
      structInfo: analysis.arrayInfo.structInfo,
      field: analysis.arrayInfo.storageField,
      ctx,
      fnCtx,
    }),
    ctx,
    fnCtx,
  });
  const loopBody = ctx.mod.block(
    null,
    [conditionCheck, loadStorage, body, ctx.mod.br(loopLabel)],
    binaryen.none,
  );
  return ctx.mod.block(
    breakLabel,
    [
      storeLocalValue({
        binding: arrayLocal,
        value: compileExpr({
          exprId: analysis.arrayExpr,
          ctx,
          fnCtx,
          expectedResultTypeId: analysis.arrayTypeId,
        }).expr,
        ctx,
        fnCtx,
      }),
      ctx.mod.local.set(cursorLocal.index, ctx.mod.i32.const(0)),
      ...forwardingStores,
      ctx.mod.loop(loopLabel, loopBody),
    ],
    binaryen.none,
  );
};

export const tryCompileArrayForStatement = ({
  block,
  statementIndex,
  ctx,
  fnCtx,
  compileExpr,
  compileStatement,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  compileStatement: StatementCompiler;
}): binaryen.ExpressionRef | undefined => {
  if (
    !intrinsicArrayForLoopCandidate({
      block,
      statementIndex,
      ctx,
      fnCtx,
    })
  ) {
    return undefined;
  }
  if (fnCtx.effectful) {
    recordFastPathDecision({
      prefix: "codegen.intrinsic_array_for",
      accepted: false,
      reason: "effectful",
    });
    return undefined;
  }
  const analysis = tryAnalyzeArrayForLoop({
    block,
    statementIndex,
    ctx,
    fnCtx,
  });
  recordFastPathDecision({
    prefix: "codegen.intrinsic_array_for",
    accepted: Boolean(analysis),
    ...(!analysis ? { reason: "shape" } : {}),
  });
  return analysis
    ? compileArrayForLoop({
        analysis,
        ctx,
        fnCtx,
        compileExpr,
        compileStatement,
      })
    : undefined;
};

const somePayloadExpr = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): HirExprId | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (
    !expr ||
    expr.exprKind !== "call" ||
    !isCallNamed({ expr, name: "some", ctx, allowSourceName: true }) ||
    expr.args.length !== 1
  ) {
    return undefined;
  }
  return expr.args[0]!.expr;
};

const parseRangeForIterator = ({
  initializer,
  ctx,
  fnCtx,
}: {
  initializer: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}):
  | {
      startExpr: HirExprId;
      endExpr: HirExprId;
      includeEnd: boolean;
      safeArray?: { arraySymbol: SymbolId };
    }
  | undefined => {
  const iterCall = ctx.module.hir.expressions.get(initializer);
  if (
    iterCall?.exprKind !== "method-call" ||
    iterCall.method !== "iter" ||
    iterCall.args.length !== 0
  ) {
    return undefined;
  }
  const range = ctx.module.hir.expressions.get(iterCall.target);
  if (range?.exprKind !== "object-literal" || range.literalKind !== "nominal") {
    return undefined;
  }
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const rangeTypeId = getRequiredExprType(iterCall.target, ctx, typeInstanceId);
  if (
    !isStdIntrinsicNominalTypeInstantiation({
      program: ctx.program,
      typeId: rangeTypeId,
      intrinsicType: STD_INTRINSIC_TYPE.range,
      typeArgs: [ctx.program.primitives.i32],
    })
  ) {
    return undefined;
  }
  const start = range.entries.find(
    (entry) => entry.kind === "field" && entry.name === "start",
  );
  const end = range.entries.find(
    (entry) => entry.kind === "field" && entry.name === "end",
  );
  const includeEnd = range.entries.find(
    (entry) => entry.kind === "field" && entry.name === "include_end",
  );
  if (!start || start.kind !== "field" || !end || end.kind !== "field") {
    return undefined;
  }
  if (!includeEnd || includeEnd.kind !== "field") {
    return undefined;
  }
  const startValue = somePayloadExpr({ exprId: start.value, ctx });
  const endValue = somePayloadExpr({ exprId: end.value, ctx });
  const isInclusive = isLiteralBoolean({
    exprId: includeEnd.value,
    value: "true",
    ctx,
  });
  const isHalfOpen = isLiteralBoolean({
    exprId: includeEnd.value,
    value: "false",
    ctx,
  });
  if (
    typeof startValue !== "number" ||
    typeof endValue !== "number" ||
    (!isInclusive && !isHalfOpen)
  ) {
    return undefined;
  }
  const length = parseArrayLenExpr({
    exprId: endValue,
    ctx,
    fnCtx,
  });
  const safeArray =
    isHalfOpen &&
    isLiteralI32({ exprId: startValue, value: "0", ctx }) &&
    length
      ? { arraySymbol: length.arraySymbol }
      : undefined;
  return {
    startExpr: startValue,
    endExpr: endValue,
    includeEnd: isInclusive,
    safeArray,
  };
};

const isLiteralBoolean = ({
  exprId,
  value,
  ctx,
}: {
  exprId: HirExprId;
  value: string;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  return (
    expr?.exprKind === "literal" &&
    expr.literalKind === "boolean" &&
    expr.value === value
  );
};

const isBreakBlock = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (expr?.exprKind === "break") {
    return true;
  }
  if (expr?.exprKind !== "block" || expr.statements.length !== 0) {
    return false;
  }
  return (
    typeof expr.value === "number" && isBreakBlock({ exprId: expr.value, ctx })
  );
};

const parseRangeForBody = ({
  whileExpr,
  iteratorSymbol,
  ctx,
}: {
  whileExpr: HirWhileExpr;
  iteratorSymbol: SymbolId;
  ctx: CodegenContext;
}):
  | {
      indexSymbol: SymbolId;
      userBodyExpr: HirExprId;
      userStatements: readonly number[];
    }
  | undefined => {
  if (!isLiteralBoolean({ exprId: whileExpr.condition, value: "true", ctx })) {
    return undefined;
  }
  const body = ctx.module.hir.expressions.get(whileExpr.body);
  if (body?.exprKind !== "block" || body.statements.length !== 1) {
    return undefined;
  }
  const nextStmt = ctx.module.hir.statements.get(body.statements[0]!);
  if (
    nextStmt?.kind !== "let" ||
    nextStmt.mutable ||
    nextStmt.pattern.kind !== "identifier"
  ) {
    return undefined;
  }
  const nextValueSymbol = nextStmt.pattern.symbol;
  const nextCall = ctx.module.hir.expressions.get(nextStmt.initializer);
  if (
    nextCall?.exprKind !== "method-call" ||
    nextCall.method !== "next" ||
    nextCall.args.length !== 0 ||
    expressionSymbol({ exprId: nextCall.target, ctx }) !== iteratorSymbol
  ) {
    return undefined;
  }
  const match =
    typeof body.value === "number"
      ? ctx.module.hir.expressions.get(body.value)
      : undefined;
  if (
    match?.exprKind !== "match" ||
    match.arms.length !== 2 ||
    expressionSymbol({ exprId: match.discriminant, ctx }) !== nextValueSymbol
  ) {
    return undefined;
  }
  const someArm = match.arms.find(
    (arm) => patternTypeName(arm.pattern) === "Some",
  );
  const noneArm = match.arms.find(
    (arm) => patternTypeName(arm.pattern) === "None",
  );
  if (!someArm || !noneArm || !isBreakBlock({ exprId: noneArm.value, ctx })) {
    return undefined;
  }
  const someBlock = ctx.module.hir.expressions.get(someArm.value);
  if (someBlock?.exprKind !== "block" || someBlock.statements.length === 0) {
    return undefined;
  }
  const indexStmt = ctx.module.hir.statements.get(someBlock.statements[0]!);
  if (
    indexStmt?.kind !== "let" ||
    indexStmt.mutable ||
    indexStmt.pattern.kind !== "identifier"
  ) {
    return undefined;
  }
  const payload = ctx.module.hir.expressions.get(indexStmt.initializer);
  if (
    payload?.exprKind !== "field-access" ||
    payload.field !== "value" ||
    expressionSymbol({ exprId: payload.target, ctx }) !== nextValueSymbol
  ) {
    return undefined;
  }
  const indexSymbol = indexStmt.pattern.symbol;
  return {
    indexSymbol,
    userBodyExpr: someArm.value,
    userStatements: someBlock.statements.slice(1),
  };
};

const tryAnalyzeRangeForLoop = ({
  block,
  statementIndex,
  ctx,
  fnCtx,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): RangeForLoopAnalysis | undefined => {
  const currentStmt = ctx.module.hir.statements.get(
    block.statements[statementIndex]!,
  );
  if (currentStmt?.kind !== "expr-stmt") {
    return undefined;
  }
  const wrapper = ctx.module.hir.expressions.get(currentStmt.expr);
  if (wrapper?.exprKind !== "block" || wrapper.statements.length !== 1) {
    return undefined;
  }
  const iteratorStmt = ctx.module.hir.statements.get(wrapper.statements[0]!);
  if (
    iteratorStmt?.kind !== "let" ||
    iteratorStmt.mutable ||
    iteratorStmt.pattern.kind !== "identifier"
  ) {
    return undefined;
  }
  const iterator = parseRangeForIterator({
    initializer: iteratorStmt.initializer,
    ctx,
    fnCtx,
  });
  const whileExpr =
    typeof wrapper.value === "number"
      ? ctx.module.hir.expressions.get(wrapper.value)
      : undefined;
  if (!iterator || whileExpr?.exprKind !== "while") {
    return undefined;
  }
  const body = parseRangeForBody({
    whileExpr,
    iteratorSymbol: iteratorStmt.pattern.symbol,
    ctx,
  });
  if (!body) {
    return undefined;
  }
  let safeArrayScope: SafeArrayLoopScope | undefined;
  if (iterator.safeArray) {
    const proof = bodyPreservesArrayLoopProof({
      bodyExprId: body.userBodyExpr,
      indexSymbol: body.indexSymbol,
      arraySymbol: iterator.safeArray.arraySymbol,
      indexUpdate: "none",
      ctx,
      fnCtx,
    });
    recordFastPathDecision({
      prefix: "codegen.range_array_safe_scope",
      accepted: proof.accepted,
      ...(!proof.accepted ? { reason: proof.reason } : {}),
    });
    if (proof.accepted) {
      safeArrayScope = {
        arraySymbol: iterator.safeArray.arraySymbol,
        indexSymbol: body.indexSymbol,
      };
    }
  }
  return {
    whileExpr,
    startExpr: iterator.startExpr,
    endExpr: iterator.endExpr,
    includeEnd: iterator.includeEnd,
    indexSymbol: body.indexSymbol,
    userBodyExpr: body.userBodyExpr,
    userStatements: body.userStatements,
    safeArrayScope,
  };
};

const compileRangeForLoop = ({
  analysis,
  ctx,
  fnCtx,
  compileExpr,
  compileStatement,
}: {
  analysis: RangeForLoopAnalysis;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  compileStatement: StatementCompiler;
}): binaryen.ExpressionRef => {
  const { loopLabel, breakLabel } = allocateLoopLabels({
    fnCtx,
    prefix: "range_for_loop",
  });
  const cursorLocal = allocateTempLocal(
    binaryen.i32,
    fnCtx,
    ctx.program.primitives.i32,
    ctx,
  );
  const endLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const indexLocal = allocateTempLocal(
    binaryen.i32,
    fnCtx,
    ctx.program.primitives.i32,
    ctx,
  );
  const doneLocal = analysis.includeEnd
    ? allocateTempLocal(binaryen.i32, fnCtx)
    : undefined;
  const previousIndexBinding = fnCtx.bindings.get(analysis.indexSymbol);
  fnCtx.bindings.set(analysis.indexSymbol, {
    ...indexLocal,
    kind: "local",
    typeId: ctx.program.primitives.i32,
  });
  const { setup: forwardingStores, value: body } = (() => {
    try {
      return withStableFieldLoadForwarding({
        loopExprId: analysis.whileExpr.id,
        ctx,
        fnCtx,
        compileExpr,
        run: () => {
          const compileBody = () =>
            withLoopScope(fnCtx, { breakLabel, continueLabel: loopLabel }, () =>
              ctx.mod.block(
                null,
                analysis.userStatements.map((stmtId) =>
                  compileStatement(stmtId),
                ),
                binaryen.none,
              ),
            );
          return analysis.safeArrayScope
            ? withSafeArrayLoopScope({
                scope: analysis.safeArrayScope,
                fnCtx,
                run: compileBody,
              })
            : compileBody();
        },
      });
    } finally {
      if (previousIndexBinding) {
        fnCtx.bindings.set(analysis.indexSymbol, previousIndexBinding);
      } else {
        fnCtx.bindings.delete(analysis.indexSymbol);
      }
    }
  })();

  const cursor = () => ctx.mod.local.get(cursorLocal.index, binaryen.i32);
  const end = () => ctx.mod.local.get(endLocal.index, binaryen.i32);
  const conditionCheck = ctx.mod.if(
    analysis.includeEnd
      ? ctx.mod.i32.or(
          ctx.mod.local.get(doneLocal!.index, binaryen.i32),
          ctx.mod.i32.gt_s(cursor(), end()),
        )
      : ctx.mod.i32.ge_s(cursor(), end()),
    ctx.mod.br(breakLabel),
  );
  const advance = analysis.includeEnd
    ? ctx.mod.if(
        ctx.mod.i32.eq(cursor(), end()),
        ctx.mod.local.set(doneLocal!.index, ctx.mod.i32.const(1)),
        ctx.mod.local.set(
          cursorLocal.index,
          ctx.mod.i32.add(cursor(), ctx.mod.i32.const(1)),
        ),
      )
    : ctx.mod.local.set(
        cursorLocal.index,
        ctx.mod.i32.add(cursor(), ctx.mod.i32.const(1)),
      );
  const loopBody = ctx.mod.block(
    null,
    [
      conditionCheck,
      ctx.mod.local.set(indexLocal.index, cursor()),
      advance,
      body,
      ctx.mod.br(loopLabel),
    ],
    binaryen.none,
  );
  return ctx.mod.block(
    breakLabel,
    [
      ctx.mod.local.set(
        cursorLocal.index,
        compileExpr({
          exprId: analysis.startExpr,
          ctx,
          fnCtx,
          expectedResultTypeId: ctx.program.primitives.i32,
        }).expr,
      ),
      ctx.mod.local.set(
        endLocal.index,
        compileExpr({
          exprId: analysis.endExpr,
          ctx,
          fnCtx,
          expectedResultTypeId: ctx.program.primitives.i32,
        }).expr,
      ),
      ...(doneLocal
        ? [ctx.mod.local.set(doneLocal.index, ctx.mod.i32.const(0))]
        : []),
      ...forwardingStores,
      ctx.mod.loop(loopLabel, loopBody),
    ],
    binaryen.none,
  );
};

export const tryCompileRangeForStatement = ({
  block,
  statementIndex,
  ctx,
  fnCtx,
  compileExpr,
  compileStatement,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  compileStatement: StatementCompiler;
}): binaryen.ExpressionRef | undefined => {
  if (
    !intrinsicRangeForLoopCandidate({
      block,
      statementIndex,
      ctx,
      fnCtx,
    })
  ) {
    return undefined;
  }
  if (fnCtx.effectful) {
    recordFastPathDecision({
      prefix: "codegen.intrinsic_range_for",
      accepted: false,
      reason: "effectful",
    });
    return undefined;
  }
  const analysis = tryAnalyzeRangeForLoop({
    block,
    statementIndex,
    ctx,
    fnCtx,
  });
  recordFastPathDecision({
    prefix: "codegen.intrinsic_range_for",
    accepted: Boolean(analysis),
    ...(!analysis ? { reason: "shape" } : {}),
  });
  return analysis
    ? compileRangeForLoop({
        analysis,
        ctx,
        fnCtx,
        compileExpr,
        compileStatement,
      })
    : undefined;
};

const activeSafeArrayLoopScope = ({
  expr,
  fnCtx,
  ctx,
}: {
  expr: HirMethodCallExpr;
  fnCtx: FunctionContext;
  ctx: CodegenContext;
}): SafeArrayLoopScope | undefined => {
  if (expr.args.length !== 1) {
    return undefined;
  }
  const targetSymbol = expressionSymbol({ exprId: expr.target, ctx });
  const indexSymbol = expressionSymbol({ exprId: expr.args[0]!.expr, ctx });
  if (typeof targetSymbol !== "number" || typeof indexSymbol !== "number") {
    return undefined;
  }
  return [...(fnCtx.safeArrayLoopScopes ?? [])]
    .reverse()
    .find(
      (scope) =>
        scope.arraySymbol === targetSymbol && scope.indexSymbol === indexSymbol,
    );
};

const compileArrayLenFastPath = ({
  expr,
  info,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirMethodCallExpr;
  info: ArrayMethodInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression | undefined => {
  if (expr.args.length !== 0) {
    return undefined;
  }

  const { setup, target } = compileArrayTarget({
    expr,
    info,
    ctx,
    fnCtx,
    compileExpr,
  });
  const count = directArrayFieldLoad({
    target,
    structInfo: info.structInfo,
    field: info.countField,
    ctx,
    fnCtx,
  });
  return {
    expr: ctx.mod.block(null, [setup, count], binaryen.i32),
    usedReturnCall: false,
  };
};

const compileArrayAtFastPath = ({
  expr,
  info,
  expectedResultTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirMethodCallExpr;
  info: ArrayMethodInfo;
  expectedResultTypeId?: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression | undefined => {
  if (expr.args.length !== 1) {
    return undefined;
  }

  const storageDesc = ctx.program.types.getTypeDesc(info.storageField.typeId);
  if (storageDesc.kind !== "fixed-array") {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const returnTypeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const resultTypeId = expectedResultTypeId ?? returnTypeId;
  const resultWasmType = getExprBinaryenType(expr.id, ctx, typeInstanceId);
  const elementStorageType = fixedArrayStorageElementType({
    typeId: storageDesc.element,
    ctx,
  });
  const safeLoopScope = activeSafeArrayLoopScope({ expr, fnCtx, ctx });
  if (safeLoopScope) {
    const storageLocal = allocateTempLocal(
      wasmTypeFor(info.storageField.typeId, ctx),
      fnCtx,
      info.storageField.typeId,
      ctx,
    );
    const indexLocal = allocateTempLocal(binaryen.i32, fnCtx);
    const { setup: setupTarget, target } = compileArrayTarget({
      expr,
      info,
      ctx,
      fnCtx,
      compileExpr,
    });
    const storage = () => loadLocalValue(storageLocal, ctx);
    const index = () => ctx.mod.local.get(indexLocal.index, binaryen.i32);
    const rawValue = arrayGet(
      ctx.mod,
      storage(),
      index(),
      elementStorageType,
      false,
    );
    const inlineValue = liftFixedArrayElementValue({
      value: rawValue,
      typeId: storageDesc.element,
      ctx,
      fnCtx,
    });
    const coerced = coerceExprToWasmType({
      expr:
        storageDesc.element === resultTypeId
          ? inlineValue
          : coerceValueToType({
              value: inlineValue,
              actualType: storageDesc.element,
              targetType: resultTypeId,
              ctx,
              fnCtx,
            }),
      targetType: resultWasmType,
      ctx,
    });

    return {
      expr: ctx.mod.block(
        null,
        [
          setupTarget,
          ctx.mod.local.set(
            indexLocal.index,
            compileExpr({
              exprId: expr.args[0]!.expr,
              ctx,
              fnCtx,
              expectedResultTypeId: ctx.program.primitives.i32,
            }).expr,
          ),
          storeLocalValue({
            binding: storageLocal,
            value: directArrayFieldLoad({
              target,
              structInfo: info.structInfo,
              field: info.storageField,
              ctx,
              fnCtx,
            }),
            ctx,
            fnCtx,
          }),
          coerced,
        ],
        resultWasmType,
      ),
      usedReturnCall: false,
    };
  }
  const storageLocal = allocateTempLocal(
    wasmTypeFor(info.storageField.typeId, ctx),
    fnCtx,
    info.storageField.typeId,
    ctx,
  );
  const countLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const indexLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const computedIndexLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const { setup: setupTarget, target } = compileArrayTarget({
    expr,
    info,
    ctx,
    fnCtx,
    compileExpr,
  });
  const storage = () => loadLocalValue(storageLocal, ctx);
  const count = () => ctx.mod.local.get(countLocal.index, binaryen.i32);
  const index = () => ctx.mod.local.get(indexLocal.index, binaryen.i32);
  const computedIndex = () =>
    ctx.mod.local.get(computedIndexLocal.index, binaryen.i32);
  const boundsCheck = ctx.mod.if(
    ctx.mod.i32.or(
      ctx.mod.i32.lt_s(computedIndex(), ctx.mod.i32.const(0)),
      ctx.mod.i32.ge_s(computedIndex(), count()),
    ),
    ctx.mod.unreachable(),
  );
  const rawValue = arrayGet(
    ctx.mod,
    storage(),
    computedIndex(),
    elementStorageType,
    false,
  );
  const inlineValue = liftFixedArrayElementValue({
    value: rawValue,
    typeId: storageDesc.element,
    ctx,
    fnCtx,
  });
  const coerced = coerceExprToWasmType({
    expr:
      storageDesc.element === resultTypeId
        ? inlineValue
        : coerceValueToType({
            value: inlineValue,
            actualType: storageDesc.element,
            targetType: resultTypeId,
            ctx,
            fnCtx,
          }),
    targetType: resultWasmType,
    ctx,
  });

  return {
    expr: ctx.mod.block(
      null,
      [
        setupTarget,
        ctx.mod.local.set(
          indexLocal.index,
          compileExpr({
            exprId: expr.args[0]!.expr,
            ctx,
            fnCtx,
            expectedResultTypeId: ctx.program.primitives.i32,
          }).expr,
        ),
        storeLocalValue({
          binding: storageLocal,
          value: directArrayFieldLoad({
            target,
            structInfo: info.structInfo,
            field: info.storageField,
            ctx,
            fnCtx,
          }),
          ctx,
          fnCtx,
        }),
        ctx.mod.local.set(
          countLocal.index,
          directArrayFieldLoad({
            target,
            structInfo: info.structInfo,
            field: info.countField,
            ctx,
            fnCtx,
          }),
        ),
        ctx.mod.local.set(
          computedIndexLocal.index,
          ctx.mod.if(
            ctx.mod.i32.lt_s(index(), ctx.mod.i32.const(0)),
            ctx.mod.i32.add(count(), index()),
            index(),
          ),
        ),
        boundsCheck,
        coerced,
      ],
      resultWasmType,
    ),
    usedReturnCall: false,
  };
};

const compileArrayGetFastPath = ({
  expr,
  info,
  expectedResultTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirMethodCallExpr;
  info: ArrayMethodInfo;
  expectedResultTypeId?: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression | undefined => {
  if (expr.args.length !== 1) {
    return undefined;
  }

  const safeLoopScope = activeSafeArrayLoopScope({ expr, fnCtx, ctx });
  if (!safeLoopScope) {
    return undefined;
  }

  const storageDesc = ctx.program.types.getTypeDesc(info.storageField.typeId);
  if (storageDesc.kind !== "fixed-array") {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const returnTypeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const resultTypeId = expectedResultTypeId ?? returnTypeId;
  const resultWasmType = getExprBinaryenType(expr.id, ctx, typeInstanceId);
  const storageLocal = allocateTempLocal(
    wasmTypeFor(info.storageField.typeId, ctx),
    fnCtx,
    info.storageField.typeId,
    ctx,
  );
  const indexLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const { setup: setupTarget, target } = compileArrayTarget({
    expr,
    info,
    ctx,
    fnCtx,
    compileExpr,
  });
  const storage = () => loadLocalValue(storageLocal, ctx);
  const index = () => ctx.mod.local.get(indexLocal.index, binaryen.i32);
  const value = liftFixedArrayElementValue({
    value: arrayGet(
      ctx.mod,
      storage(),
      index(),
      fixedArrayStorageElementType({ typeId: storageDesc.element, ctx }),
      false,
    ),
    typeId: storageDesc.element,
    ctx,
    fnCtx,
  });
  const some = coerceValueToType({
    value,
    actualType: storageDesc.element,
    targetType: resultTypeId,
    ctx,
    fnCtx,
  });

  return {
    expr: ctx.mod.block(
      null,
      [
        setupTarget,
        ctx.mod.local.set(
          indexLocal.index,
          compileExpr({
            exprId: expr.args[0]!.expr,
            ctx,
            fnCtx,
            expectedResultTypeId: ctx.program.primitives.i32,
          }).expr,
        ),
        storeLocalValue({
          binding: storageLocal,
          value: directArrayFieldLoad({
            target,
            structInfo: info.structInfo,
            field: info.storageField,
            ctx,
            fnCtx,
          }),
          ctx,
          fnCtx,
        }),
        coerceExprToWasmType({ expr: some, targetType: resultWasmType, ctx }),
      ],
      resultWasmType,
    ),
    usedReturnCall: false,
  };
};

export const tryCompileArrayMethodFastPath = ({
  expr,
  expectedResultTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirMethodCallExpr;
  expectedResultTypeId?: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression | undefined => {
  if (expr.method !== "len" && expr.method !== "at" && expr.method !== "get") {
    return undefined;
  }
  const info = arrayMethodInfo({ expr, ctx, fnCtx });
  if (!info) {
    return undefined;
  }
  if (expr.method === "len") {
    return compileArrayLenFastPath({ expr, info, ctx, fnCtx, compileExpr });
  }
  if (expr.method === "get") {
    return compileArrayGetFastPath({
      expr,
      info,
      expectedResultTypeId,
      ctx,
      fnCtx,
      compileExpr,
    });
  }
  return compileArrayAtFastPath({
    expr,
    info,
    expectedResultTypeId,
    ctx,
    fnCtx,
    compileExpr,
  });
};
