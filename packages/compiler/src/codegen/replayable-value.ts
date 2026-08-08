import binaryen from "binaryen";
import type { CodegenContext, FunctionContext } from "./context.js";

type ReplayableCodegenContext = Pick<CodegenContext, "mod">;
type ReplayableFunctionContext = Pick<
  FunctionContext,
  "locals" | "nextLocalIndex"
>;

/**
 * A computed value split into the setup that evaluates its producer once and a
 * read that can be emitted any number of times by implicit consumers.
 *
 * Lowering must keep setup at the source occurrence's original evaluation
 * point. Reads belong to that same control-flow region; they must not be moved
 * across branches, handlers, suspension points, argument/default evaluation,
 * borrow activation, or runtime guards.
 */
export interface ReplayableValue {
  setup: readonly binaryen.ExpressionRef[];
  read: () => binaryen.ExpressionRef;
}

/**
 * Returns true only for leaves that are already safe to rematerialize.
 *
 * This deliberately does not inspect Voyd effect rows. Calls, allocations,
 * loads, casts, and other computed expressions are stabilized even when their
 * source type is nominally pure.
 */
export const isAlreadyReplayableValue = (
  value: binaryen.ExpressionRef,
): boolean => {
  const id = binaryen.getExpressionId(value);
  return (
    id === binaryen.ConstId ||
    id === binaryen.LocalGetId ||
    id === binaryen.RefNullId ||
    id === binaryen.RefFuncId ||
    id === binaryen.NopId
  );
};

export const stabilizeValueForReplay = ({
  value,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  ctx: ReplayableCodegenContext;
  fnCtx?: ReplayableFunctionContext;
}): ReplayableValue => {
  const type = binaryen.getExpressionType(value);
  if (type === binaryen.unreachable) {
    return {
      setup: [value],
      read: () => ctx.mod.unreachable(),
    };
  }
  if (type === binaryen.none) {
    return {
      setup: [value],
      read: () => ctx.mod.nop(),
    };
  }

  if (isAlreadyReplayableValue(value)) {
    return {
      setup: [],
      read: () => ctx.mod.copyExpression(value),
    };
  }

  if (binaryen.getExpressionId(value) === binaryen.TupleMakeId) {
    const values = (binaryen.getExpressionInfo(value) as binaryen.TupleMakeInfo)
      .operands;
    const operands = stabilizeValuesForReplay({ values, ctx, fnCtx });
    return {
      setup: operands.flatMap((operand) => operand.setup),
      read: () => ctx.mod.tuple.make(operands.map((operand) => operand.read())),
    };
  }

  if (!fnCtx) {
    throw new Error(
      "computed value requires a function context before it can be replayed",
    );
  }

  const index = fnCtx.nextLocalIndex;
  fnCtx.nextLocalIndex += 1;
  fnCtx.locals.push(type);
  return {
    setup: [ctx.mod.local.set(index, value)],
    read: () => ctx.mod.local.get(index, type),
  };
};

/**
 * Stabilizes sibling values while preserving their left-to-right evaluation
 * order. Local reads are snapshotted when setup for a later sibling could
 * otherwise run before the read is consumed.
 */
export const stabilizeValuesForReplay = ({
  values,
  ctx,
  fnCtx,
}: {
  values: readonly binaryen.ExpressionRef[];
  ctx: ReplayableCodegenContext;
  fnCtx?: ReplayableFunctionContext;
}): ReplayableValue[] => {
  const replayable = values.map((value) =>
    stabilizeValueForReplay({ value, ctx, fnCtx }),
  );
  let hasLaterSetup = false;
  for (let index = replayable.length - 1; index >= 0; index -= 1) {
    const value = values[index]!;
    const current = replayable[index]!;
    if (hasLaterSetup && current.setup.length === 0 && readsLocalValue(value)) {
      replayable[index] = snapshotLocalReads({ value, ctx, fnCtx });
    }
    hasLaterSetup ||= replayable[index]!.setup.length > 0;
  }
  return replayable;
};

const readsLocalValue = (value: binaryen.ExpressionRef): boolean => {
  const id = binaryen.getExpressionId(value);
  if (id === binaryen.LocalGetId) {
    return true;
  }
  if (id !== binaryen.TupleMakeId) {
    return false;
  }
  return (
    binaryen.getExpressionInfo(value) as binaryen.TupleMakeInfo
  ).operands.some(readsLocalValue);
};

const snapshotLocalReads = ({
  value,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  ctx: ReplayableCodegenContext;
  fnCtx?: ReplayableFunctionContext;
}): ReplayableValue => {
  if (binaryen.getExpressionId(value) === binaryen.TupleMakeId) {
    const operands = (
      binaryen.getExpressionInfo(value) as binaryen.TupleMakeInfo
    ).operands.map((operand) =>
      readsLocalValue(operand)
        ? snapshotLocalReads({ value: operand, ctx, fnCtx })
        : stabilizeValueForReplay({ value: operand, ctx, fnCtx }),
    );
    return {
      setup: operands.flatMap((operand) => operand.setup),
      read: () => ctx.mod.tuple.make(operands.map((operand) => operand.read())),
    };
  }

  if (!fnCtx) {
    throw new Error(
      "local reads require a function context when later tuple operands have setup",
    );
  }
  const type = binaryen.getExpressionType(value);
  const index = fnCtx.nextLocalIndex;
  fnCtx.nextLocalIndex += 1;
  fnCtx.locals.push(type);
  return {
    setup: [ctx.mod.local.set(index, value)],
    read: () => ctx.mod.local.get(index, type),
  };
};

export const withReplayableSetup = ({
  replayable,
  value,
  ctx,
}: {
  replayable: ReplayableValue;
  value: binaryen.ExpressionRef;
  ctx: ReplayableCodegenContext;
}): binaryen.ExpressionRef =>
  replayable.setup.length === 0
    ? value
    : ctx.mod.block(
        null,
        [...replayable.setup, value],
        binaryen.getExpressionType(value),
      );
