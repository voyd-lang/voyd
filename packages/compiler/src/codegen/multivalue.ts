import binaryen from "binaryen";
import type { CodegenContext, FunctionContext } from "./context.js";

export const MAX_MULTIVALUE_INLINE_LANES = 4;

const allocateTempLocal = ({
  type,
  fnCtx,
}: {
  type: binaryen.Type;
  fnCtx: FunctionContext;
}): number => {
  const index = fnCtx.nextLocalIndex;
  fnCtx.nextLocalIndex += 1;
  fnCtx.locals.push(type);
  return index;
};

export const captureMultivalueLanes = ({
  value,
  abiTypes,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  abiTypes: readonly binaryen.Type[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): {
  setup: readonly binaryen.ExpressionRef[];
  lanes: readonly binaryen.ExpressionRef[];
} => {
  if (abiTypes.length <= 1) {
    return {
      setup: [],
      lanes: abiTypes.length === 0 ? [] : [value],
    };
  }

  const tupleType = binaryen.createType(abiTypes as number[]);
  const tupleLocal = allocateTempLocal({ type: tupleType, fnCtx });

  if (abiTypes.length <= MAX_MULTIVALUE_INLINE_LANES) {
    return {
      setup: [ctx.mod.local.set(tupleLocal, value)],
      lanes: abiTypes.map((_, index) =>
        ctx.mod.tuple.extract(ctx.mod.local.get(tupleLocal, tupleType), index),
      ),
    };
  }

  const laneLocals = abiTypes.map((type) => ({
    index: allocateTempLocal({ type, fnCtx }),
    type,
  }));
  const tupleValue = (): binaryen.ExpressionRef =>
    ctx.mod.local.get(tupleLocal, tupleType);

  return {
    setup: [
      ctx.mod.local.set(tupleLocal, value),
      ...laneLocals.map((lane, index) =>
        ctx.mod.local.set(lane.index, ctx.mod.tuple.extract(tupleValue(), index)),
      ),
    ],
    lanes: laneLocals.map((lane) =>
      ctx.mod.local.get(lane.index, lane.type),
    ),
  };
};
