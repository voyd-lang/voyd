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
import {
  allocateLoopLabels,
  withLoopScope,
} from "../control-flow-stack.js";
import { walkHirExpression } from "../hir-walk.js";
import { allocateTempLocal, loadLocalValue, storeLocalValue } from "../locals.js";
import {
  coerceValueToType,
  fixedArrayStorageElementType,
  liftFixedArrayElementValue,
  liftHeapValueToInline,
} from "../structural.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
  getStructuralTypeInfo,
  wasmTypeFor,
} from "../types.js";
import { coerceExprToWasmType } from "../wasm-type-coercions.js";

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

type SafeArrayForLoopAnalysis = {
  scope: SafeArrayLoopScope;
  lengthExpr: HirExprId;
  userStatements: readonly number[];
};

type StatementCompiler = (stmtId: number) => binaryen.ExpressionRef;

const isStdArrayType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): boolean => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  const nominal =
    desc.kind === "nominal-object"
      ? desc
      : desc.kind === "intersection" && typeof desc.nominal === "number"
        ? ctx.program.types.getTypeDesc(desc.nominal)
        : undefined;
  if (nominal?.kind !== "nominal-object") {
    return false;
  }
  return (
    nominal.name === "Array" &&
    ctx.program.symbols.getPackageId(nominal.owner) === "std"
  );
};

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
}: {
  target: () => binaryen.ExpressionRef;
  structInfo: StructuralTypeInfo;
  field: StructuralFieldInfo;
  ctx: CodegenContext;
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
}: {
  expr: HirCallExpr;
  name: string;
  ctx: CodegenContext;
}): boolean => {
  const callee = ctx.module.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return false;
  }
  const calleeId = ctx.program.symbols.canonicalIdOf(ctx.moduleId, callee.symbol);
  return (
    ctx.program.symbols.getName(calleeId) === name ||
    ctx.program.symbols.getIntrinsicName(calleeId) === name
  );
};

const isCallNamed = ({
  expr,
  name,
  ctx,
}: {
  expr: HirExpression;
  name: string;
  ctx: CodegenContext;
}): boolean =>
  expr.exprKind === "call" && callHasName({ expr, name, ctx });

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
  const leftSymbol = left ? expressionSymbol({ exprId: left.expr, ctx }) : undefined;
  const rightSymbol = right
    ? expressionSymbol({ exprId: right.expr, ctx })
    : undefined;

  return (
    (leftSymbol === indexSymbol &&
      Boolean(right && isLiteralI32({ exprId: right.expr, value: "1", ctx }))) ||
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
  if (expr.method !== "at" || expr.args.length !== 1) {
    return false;
  }
  return expressionSymbol({ exprId: expr.args[0]!.expr, ctx }) === indexSymbol;
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
}): boolean => {
  const arrayAliases = aliasesFor({ symbol: arraySymbol, fnCtx });
  let indexIncrements = 0;
  let valid = true;

  walkHirExpression({
    exprId: bodyExprId,
    ctx,
    visitor: {
      onExpr: (exprId, expr) => {
        if (!valid) {
          return "stop";
        }
        if (exprId !== bodyExprId && (expr.exprKind === "while" || expr.exprKind === "loop")) {
          valid = false;
          return "stop";
        }
        if (expr.exprKind === "break" || expr.exprKind === "continue") {
          valid = false;
          return "stop";
        }
        if (expr.exprKind === "assign") {
          const targetSymbol = targetIdentifierSymbol({
            exprId: expr.target,
            ctx,
          });
          if (typeof targetSymbol === "number" && arrayAliases.has(targetSymbol)) {
            valid = false;
            return "stop";
          }
          if (targetSymbol === indexSymbol) {
            if (!exprIsIndexIncrement({ exprId: expr.value, indexSymbol, ctx })) {
              valid = false;
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
            !isSafeArrayLoopRead({ expr, indexSymbol, ctx })
          ) {
            valid = false;
            return "stop";
          }
          return undefined;
        }
        if (expr.exprKind === "call") {
          if (
            expr.args.some((arg) => {
              const argSymbol = expressionSymbol({ exprId: arg.expr, ctx });
              return typeof argSymbol === "number" && arrayAliases.has(argSymbol);
            })
          ) {
            valid = false;
            return "stop";
          }
        }
        return undefined;
      },
    },
  });

  return valid && indexIncrements === (indexUpdate === "increment" ? 1 : 0);
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
}): {
  indexSymbol: SymbolId;
  arraySymbol: SymbolId;
  cachedLengthExpr?: HirExprId;
} | undefined => {
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
}): SafeArrayWhileLoopAnalysis | undefined => {
  const currentStmtId = block.statements[statementIndex];
  const currentStmt =
    typeof currentStmtId === "number"
      ? ctx.module.hir.statements.get(currentStmtId)
      : undefined;
  if (currentStmt?.kind !== "expr-stmt") {
    return undefined;
  }
  const whileExpr = ctx.module.hir.expressions.get(currentStmt.expr);
  if (whileExpr?.exprKind !== "while") {
    return undefined;
  }

  const condition = analyzeWhileCondition({
    expr: whileExpr,
    block,
    statementIndex,
    ctx,
    fnCtx,
  });
  if (!condition) {
    return undefined;
  }

  const indexInit = indexInitStatement({
    block,
    statementIndex,
    indexSymbol: condition.indexSymbol,
    ctx,
  });
  if (!indexInit) {
    return undefined;
  }

  if (
    !bodyPreservesArrayLoopProof({
      bodyExprId: whileExpr.body,
      indexSymbol: indexInit.indexSymbol,
      arraySymbol: condition.arraySymbol,
      indexUpdate: "increment",
      ctx,
      fnCtx,
    })
  ) {
    return undefined;
  }

  return {
    whileExpr,
    scope: {
      arraySymbol: condition.arraySymbol,
      indexSymbol: indexInit.indexSymbol,
    },
    cachedLengthExpr: condition.cachedLengthExpr,
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
  return ctx.mod.local.get(binding.index, binaryen.i32);
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
  const analysis = tryAnalyzeSafeArrayWhileLoop({
    block,
    statementIndex,
    ctx,
    fnCtx,
  });
  if (!analysis) {
    return undefined;
  }
  return compileSafeArrayWhileLoop({
    analysis,
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
    !isCallNamed({ expr, name: "some", ctx }) ||
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
}): { arraySymbol: SymbolId; lengthExpr: HirExprId } | undefined => {
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
  const start = range.entries.find((entry) => entry.kind === "field" && entry.name === "start");
  const end = range.entries.find((entry) => entry.kind === "field" && entry.name === "end");
  const includeEnd = range.entries.find(
    (entry) => entry.kind === "field" && entry.name === "include_end",
  );
  if (!start || start.kind !== "field" || !end || end.kind !== "field") {
    return undefined;
  }
  if (
    !includeEnd ||
    includeEnd.kind !== "field" ||
    !isLiteralBoolean({ exprId: includeEnd.value, value: "false", ctx })
  ) {
    return undefined;
  }
  const startValue = somePayloadExpr({ exprId: start.value, ctx });
  const endValue = somePayloadExpr({ exprId: end.value, ctx });
  if (
    typeof startValue !== "number" ||
    !isLiteralI32({ exprId: startValue, value: "0", ctx }) ||
    typeof endValue !== "number"
  ) {
    return undefined;
  }
  const length = parseArrayLenExpr({
    exprId: endValue,
    ctx,
    fnCtx,
  });
  return length
    ? {
        arraySymbol: length.arraySymbol,
        lengthExpr: endValue,
      }
    : undefined;
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
  return typeof expr.value === "number" && isBreakBlock({ exprId: expr.value, ctx });
};

const parseRangeForBody = ({
  whileExpr,
  iteratorSymbol,
  arraySymbol,
  ctx,
  fnCtx,
}: {
  whileExpr: HirWhileExpr;
  iteratorSymbol: SymbolId;
  arraySymbol: SymbolId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): { indexSymbol: SymbolId; userStatements: readonly number[] } | undefined => {
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
    expressionSymbol({ exprId: nextCall.target, ctx }) !== iteratorSymbol
  ) {
    return undefined;
  }
  const match = typeof body.value === "number"
    ? ctx.module.hir.expressions.get(body.value)
    : undefined;
  if (
    match?.exprKind !== "match" ||
    expressionSymbol({ exprId: match.discriminant, ctx }) !== nextValueSymbol
  ) {
    return undefined;
  }
  const someArm = match.arms.find((arm) => patternTypeName(arm.pattern) === "Some");
  const noneArm = match.arms.find((arm) => patternTypeName(arm.pattern) === "None");
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
  if (
    !bodyPreservesArrayLoopProof({
      bodyExprId: someArm.value,
      indexSymbol,
      arraySymbol,
      indexUpdate: "none",
      ctx,
      fnCtx,
    })
  ) {
    return undefined;
  }
  return {
    indexSymbol,
    userStatements: someBlock.statements.slice(1),
  };
};

const tryAnalyzeSafeArrayForLoop = ({
  block,
  statementIndex,
  ctx,
  fnCtx,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): SafeArrayForLoopAnalysis | undefined => {
  const currentStmt = ctx.module.hir.statements.get(block.statements[statementIndex]!);
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
  const whileExpr = typeof wrapper.value === "number"
    ? ctx.module.hir.expressions.get(wrapper.value)
    : undefined;
  if (!iterator || whileExpr?.exprKind !== "while") {
    return undefined;
  }
  const body = parseRangeForBody({
    whileExpr,
    iteratorSymbol: iteratorStmt.pattern.symbol,
    arraySymbol: iterator.arraySymbol,
    ctx,
    fnCtx,
  });
  if (!body) {
    return undefined;
  }
  return {
    scope: {
      arraySymbol: iterator.arraySymbol,
      indexSymbol: body.indexSymbol,
    },
    lengthExpr: iterator.lengthExpr,
    userStatements: body.userStatements,
  };
};

const compileSafeArrayForLoop = ({
  analysis,
  ctx,
  fnCtx,
  compileExpr,
  compileStatement,
}: {
  analysis: SafeArrayForLoopAnalysis;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  compileStatement: StatementCompiler;
}): binaryen.ExpressionRef => {
  const { loopLabel, breakLabel } = allocateLoopLabels({
    fnCtx,
    prefix: "array_safe_for_loop",
  });
  const lengthLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const indexLocal = allocateTempLocal(
    binaryen.i32,
    fnCtx,
    ctx.program.primitives.i32,
    ctx,
  );
  const previousIndexBinding = fnCtx.bindings.get(analysis.scope.indexSymbol);
  fnCtx.bindings.set(analysis.scope.indexSymbol, {
    ...indexLocal,
    kind: "local",
    typeId: ctx.program.primitives.i32,
  });
  const body = (() => {
    try {
      return withSafeArrayLoopScope({
        scope: analysis.scope,
        fnCtx,
        run: () =>
          withLoopScope(
            fnCtx,
            { breakLabel, continueLabel: loopLabel },
            () =>
              ctx.mod.block(
                null,
                analysis.userStatements.map((stmtId) => compileStatement(stmtId)),
                binaryen.none,
              ),
          ),
      });
    } finally {
      if (previousIndexBinding) {
        fnCtx.bindings.set(analysis.scope.indexSymbol, previousIndexBinding);
      } else {
        fnCtx.bindings.delete(analysis.scope.indexSymbol);
      }
    }
  })();

  const conditionCheck = ctx.mod.if(
    ctx.mod.i32.eqz(
      ctx.mod.i32.lt_s(
        ctx.mod.local.get(indexLocal.index, binaryen.i32),
        ctx.mod.local.get(lengthLocal.index, binaryen.i32),
      ),
    ),
    ctx.mod.br(breakLabel),
  );
  const loopBody = ctx.mod.block(
    null,
    [
      conditionCheck,
      body,
      ctx.mod.local.set(
        indexLocal.index,
        ctx.mod.i32.add(
          ctx.mod.local.get(indexLocal.index, binaryen.i32),
          ctx.mod.i32.const(1),
        ),
      ),
      ctx.mod.br(loopLabel),
    ],
    binaryen.none,
  );
  return ctx.mod.block(
    breakLabel,
    [
      ctx.mod.local.set(
        lengthLocal.index,
        compileExpr({
          exprId: analysis.lengthExpr,
          ctx,
          fnCtx,
          expectedResultTypeId: ctx.program.primitives.i32,
        }).expr,
      ),
      ctx.mod.local.set(indexLocal.index, ctx.mod.i32.const(0)),
      ctx.mod.loop(loopLabel, loopBody),
    ],
    binaryen.none,
  );
};

export const tryCompileArraySafeForStatement = ({
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
  const analysis = tryAnalyzeSafeArrayForLoop({
    block,
    statementIndex,
    ctx,
    fnCtx,
  });
  return analysis
    ? compileSafeArrayForLoop({
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
  if (expr.method !== "len" && expr.method !== "at") {
    return undefined;
  }
  const info = arrayMethodInfo({ expr, ctx, fnCtx });
  if (!info) {
    return undefined;
  }
  if (expr.method === "len") {
    return compileArrayLenFastPath({ expr, info, ctx, fnCtx, compileExpr });
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
