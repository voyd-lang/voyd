import type { HirExprId } from "../../context.js";

const cantorPair = (a: number, b: number): number => ((a + b) * (a + b + 1)) / 2 + b;

const handlerClauseBaseId = ({
  handlerExprId,
  clauseIndex,
}: {
  handlerExprId: HirExprId;
  clauseIndex: number;
}): number => cantorPair(handlerExprId, clauseIndex) * 2;

export const handlerClauseContinuationTempId = ({
  handlerExprId,
  clauseIndex,
}: {
  handlerExprId: HirExprId;
  clauseIndex: number;
}): number => -1 - (handlerClauseBaseId({ handlerExprId, clauseIndex }) + 0);

export const handlerClauseTailGuardTempId = ({
  handlerExprId,
  clauseIndex,
}: {
  handlerExprId: HirExprId;
  clauseIndex: number;
}): number => -1 - (handlerClauseBaseId({ handlerExprId, clauseIndex }) + 1);

