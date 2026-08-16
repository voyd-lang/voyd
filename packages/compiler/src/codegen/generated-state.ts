import type {
  CodegenContext,
  HirCallExpr,
  HirExprId,
  HirPattern,
  HirStmtId,
  HirWhileExpr,
  SymbolId,
  TypeId,
} from "./context.js";
import type { ProgramFunctionInstanceId } from "../semantics/ids.js";
import { walkHirExpression } from "./hir-walk.js";
import { getRequiredExprType } from "./types.js";
import {
  isStdIntrinsicNominalTypeInstantiation,
  STD_INTRINSIC_TYPE,
} from "../compiler-contracts/types.js";

export interface GeneratedStateField {
  name: string;
  tempId: number;
  typeId: TypeId;
}

export interface GeneratedStateResumeRegion {
  name: string;
  exprId: HirExprId;
  captureFields: readonly string[];
  replacedSymbols: readonly SymbolId[];
  replacedTempOwners: readonly HirExprId[];
}

export interface GeneratedRangeLoopState {
  kind: "range-loop";
  statementId: HirStmtId;
  whileExprId: HirExprId;
  startExprId: HirExprId;
  endExprId: HirExprId;
  bodyExprId: HirExprId;
  includeEnd: boolean;
  fields: readonly GeneratedStateField[];
  resumeRegions: readonly GeneratedStateResumeRegion[];
}

export type CompilerGeneratedState = GeneratedRangeLoopState;

export interface GeneratedRangeLoopShape {
  statementId: HirStmtId;
  whileExpr: HirWhileExpr;
  iteratorExprId: HirExprId;
  rangeExprId: HirExprId;
  startExpr: HirExprId;
  endExpr: HirExprId;
  includeEnd: boolean;
  indexSymbol: SymbolId;
  iteratorSymbol: SymbolId;
  nextValueSymbol: SymbolId;
  userBodyExpr: HirExprId;
  userStatements: readonly HirStmtId[];
}

export const generatedStateField = ({
  state,
  name,
}: {
  state: CompilerGeneratedState;
  name: string;
}): GeneratedStateField | undefined =>
  state.fields.find((field) => field.name === name);

export const generatedStateResumeRegion = ({
  state,
  name,
}: {
  state: CompilerGeneratedState;
  name: string;
}): GeneratedStateResumeRegion | undefined =>
  state.resumeRegions.find((region) => region.name === name);

export const generatedRangeLoopStateMatchesShape = ({
  state,
  shape,
  i32TypeId,
}: {
  state: GeneratedRangeLoopState;
  shape: GeneratedRangeLoopShape;
  i32TypeId: TypeId;
}): boolean => {
  const expectedFieldNames = shape.includeEnd
    ? ["cursor", "end", "done"]
    : ["cursor", "end"];
  if (
    state.statementId !== shape.statementId ||
    state.whileExprId !== shape.whileExpr.id ||
    state.startExprId !== shape.startExpr ||
    state.endExprId !== shape.endExpr ||
    state.bodyExprId !== shape.userBodyExpr ||
    state.includeEnd !== shape.includeEnd ||
    state.fields.length !== expectedFieldNames.length ||
    !state.fields.every(
      (field, index) =>
        field.name === expectedFieldNames[index] && field.typeId === i32TypeId,
    ) ||
    state.resumeRegions.length !== 2
  ) {
    return false;
  }

  const endRegion = generatedStateResumeRegion({
    state,
    name: "end-bound",
  });
  const bodyRegion = generatedStateResumeRegion({
    state,
    name: "loop-body",
  });
  return Boolean(
    endRegion &&
    endRegion.exprId === shape.endExpr &&
    arraysEqual(endRegion.captureFields, ["cursor"]) &&
    endRegion.replacedSymbols.length === 0 &&
    arraysEqual(endRegion.replacedTempOwners, [
      shape.rangeExprId,
      shape.iteratorExprId,
    ]) &&
    bodyRegion &&
    bodyRegion.exprId === shape.userBodyExpr &&
    arraysEqual(bodyRegion.captureFields, expectedFieldNames) &&
    arraysEqual(bodyRegion.replacedSymbols, [
      shape.iteratorSymbol,
      shape.nextValueSymbol,
    ]) &&
    bodyRegion.replacedTempOwners.length === 0,
  );
};

const arraysEqual = <T>(left: readonly T[], right: readonly T[]): boolean =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

export const describeGeneratedRangeLoopState = ({
  shape,
  i32TypeId,
  allocateTempId,
}: {
  shape: GeneratedRangeLoopShape;
  i32TypeId: TypeId;
  allocateTempId: (fieldName: string, typeId: TypeId) => number;
}): GeneratedRangeLoopState => {
  const fields: GeneratedStateField[] = [
    {
      name: "cursor",
      tempId: allocateTempId("cursor", i32TypeId),
      typeId: i32TypeId,
    },
    {
      name: "end",
      tempId: allocateTempId("end", i32TypeId),
      typeId: i32TypeId,
    },
    ...(shape.includeEnd
      ? [
          {
            name: "done",
            tempId: allocateTempId("done", i32TypeId),
            typeId: i32TypeId,
          },
        ]
      : []),
  ];
  return {
    kind: "range-loop",
    statementId: shape.statementId,
    whileExprId: shape.whileExpr.id,
    startExprId: shape.startExpr,
    endExprId: shape.endExpr,
    bodyExprId: shape.userBodyExpr,
    includeEnd: shape.includeEnd,
    fields,
    resumeRegions: [
      {
        name: "end-bound",
        exprId: shape.endExpr,
        captureFields: ["cursor"],
        replacedSymbols: [],
        replacedTempOwners: [shape.rangeExprId, shape.iteratorExprId],
      },
      {
        name: "loop-body",
        exprId: shape.userBodyExpr,
        captureFields: fields.map((field) => field.name),
        replacedSymbols: [shape.iteratorSymbol, shape.nextValueSymbol],
        replacedTempOwners: [],
      },
    ],
  };
};

export const collectGeneratedRangeLoopShapes = ({
  rootExprId,
  ctx,
  typeInstanceId,
}: {
  rootExprId: HirExprId;
  ctx: CodegenContext;
  typeInstanceId?: ProgramFunctionInstanceId;
}): readonly GeneratedRangeLoopShape[] => {
  const shapes = new Map<HirStmtId, GeneratedRangeLoopShape>();
  walkHirExpression({
    exprId: rootExprId,
    ctx,
    visitLambdaBodies: false,
    visitor: {
      onExpr: (_exprId, expr) => {
        if (expr.exprKind !== "block") return;
        expr.statements.forEach((statementId) => {
          const shape = analyzeGeneratedRangeLoop({
            statementId,
            ctx,
            typeInstanceId,
          });
          if (shape) shapes.set(statementId, shape);
        });
      },
    },
  });
  return [...shapes.values()];
};

export const analyzeGeneratedRangeLoop = ({
  statementId,
  ctx,
  typeInstanceId,
}: {
  statementId: HirStmtId;
  ctx: CodegenContext;
  typeInstanceId?: ProgramFunctionInstanceId;
}): GeneratedRangeLoopShape | undefined => {
  const statement = ctx.module.hir.statements.get(statementId);
  const wrapper =
    statement?.kind === "expr-stmt"
      ? ctx.module.hir.expressions.get(statement.expr)
      : undefined;
  if (wrapper?.exprKind !== "block" || wrapper.statements.length !== 1) {
    return undefined;
  }
  const iteratorStatement = ctx.module.hir.statements.get(
    wrapper.statements[0]!,
  );
  if (
    iteratorStatement?.kind !== "let" ||
    iteratorStatement.mutable ||
    iteratorStatement.pattern.kind !== "identifier"
  ) {
    return undefined;
  }
  const iterator = parseRangeIterator({
    initializer: iteratorStatement.initializer,
    ctx,
    typeInstanceId,
  });
  const whileExpr =
    typeof wrapper.value === "number"
      ? ctx.module.hir.expressions.get(wrapper.value)
      : undefined;
  if (!iterator || whileExpr?.exprKind !== "while") {
    return undefined;
  }
  const body = parseRangeBody({
    whileExpr,
    iteratorSymbol: iteratorStatement.pattern.symbol,
    ctx,
  });
  return body
    ? {
        statementId,
        whileExpr,
        iteratorSymbol: iteratorStatement.pattern.symbol,
        ...iterator,
        ...body,
      }
    : undefined;
};

const parseRangeIterator = ({
  initializer,
  ctx,
  typeInstanceId,
}: {
  initializer: HirExprId;
  ctx: CodegenContext;
  typeInstanceId?: ProgramFunctionInstanceId;
}):
  | {
      iteratorExprId: HirExprId;
      rangeExprId: HirExprId;
      startExpr: HirExprId;
      endExpr: HirExprId;
      includeEnd: boolean;
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
  if (
    !start ||
    start.kind !== "field" ||
    !end ||
    end.kind !== "field" ||
    !includeEnd ||
    includeEnd.kind !== "field"
  ) {
    return undefined;
  }
  const startValue = somePayloadExpr({ exprId: start.value, ctx });
  const endValue = somePayloadExpr({ exprId: end.value, ctx });
  const inclusive = isLiteralBoolean({
    exprId: includeEnd.value,
    value: "true",
    ctx,
  });
  const halfOpen = isLiteralBoolean({
    exprId: includeEnd.value,
    value: "false",
    ctx,
  });
  return typeof startValue === "number" &&
    typeof endValue === "number" &&
    (inclusive || halfOpen)
    ? {
        iteratorExprId: iterCall.id,
        rangeExprId: range.id,
        startExpr: startValue,
        endExpr: endValue,
        includeEnd: inclusive,
      }
    : undefined;
};

const parseRangeBody = ({
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
      nextValueSymbol: SymbolId;
      userBodyExpr: HirExprId;
      userStatements: readonly HirStmtId[];
    }
  | undefined => {
  if (!isLiteralBoolean({ exprId: whileExpr.condition, value: "true", ctx })) {
    return undefined;
  }
  const body = ctx.module.hir.expressions.get(whileExpr.body);
  if (body?.exprKind !== "block" || body.statements.length !== 1) {
    return undefined;
  }
  const nextStatement = ctx.module.hir.statements.get(body.statements[0]!);
  if (
    nextStatement?.kind !== "let" ||
    nextStatement.mutable ||
    nextStatement.pattern.kind !== "identifier"
  ) {
    return undefined;
  }
  const nextValueSymbol = nextStatement.pattern.symbol;
  const nextCall = ctx.module.hir.expressions.get(nextStatement.initializer);
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
  const indexStatement = ctx.module.hir.statements.get(
    someBlock.statements[0]!,
  );
  if (
    indexStatement?.kind !== "let" ||
    indexStatement.mutable ||
    indexStatement.pattern.kind !== "identifier"
  ) {
    return undefined;
  }
  const payload = ctx.module.hir.expressions.get(indexStatement.initializer);
  if (
    payload?.exprKind !== "field-access" ||
    payload.field !== "value" ||
    expressionSymbol({ exprId: payload.target, ctx }) !== nextValueSymbol
  ) {
    return undefined;
  }
  return {
    indexSymbol: indexStatement.pattern.symbol,
    nextValueSymbol,
    userBodyExpr: someArm.value,
    userStatements: someBlock.statements.slice(1),
  };
};

const somePayloadExpr = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): HirExprId | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  return expr?.exprKind === "call" &&
    callHasName({ expr, name: "some", ctx, allowSourceName: true }) &&
    expr.args.length === 1
    ? expr.args[0]!.expr
    : undefined;
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
  const callee = ctx.module.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") return false;
  const calleeId = ctx.program.symbols.canonicalIdOf(
    ctx.moduleId,
    callee.symbol,
  );
  const intrinsicName = ctx.program.symbols.getIntrinsicName(calleeId);
  const intrinsicFlags =
    ctx.program.symbols.getIntrinsicFunctionFlags(calleeId);
  return (
    intrinsicName === name ||
    (intrinsicFlags.intrinsic &&
      ctx.program.symbols.getName(calleeId) === name) ||
    (allowSourceName && ctx.program.symbols.getName(calleeId) === name)
  );
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
  if (expr?.exprKind === "break") return true;
  return expr?.exprKind === "block" &&
    expr.statements.length === 0 &&
    typeof expr.value === "number"
    ? isBreakBlock({ exprId: expr.value, ctx })
    : false;
};

const patternTypeName = (pattern: HirPattern): string | undefined =>
  pattern.kind === "type" && pattern.type.typeKind === "named"
    ? pattern.type.path.at(-1)
    : undefined;
