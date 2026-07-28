import binaryen from "binaryen";
import type { CodegenContext } from "./context.js";
import {
  captureMultivalueLanes,
  type LocalAllocationContext,
} from "./multivalue.js";

export const preserveResultAcrossOperations = ({
  value,
  operations,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  operations: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: LocalAllocationContext;
}): binaryen.ExpressionRef => {
  if (operations.length === 0) {
    return value;
  }

  const resultType = binaryen.getExpressionType(value);
  if (resultType === binaryen.unreachable) {
    return value;
  }
  if (resultType === binaryen.none) {
    return ctx.mod.block(null, [value, ...operations], binaryen.none);
  }

  const resultTypes = [...binaryen.expandType(resultType)];
  if (resultTypes.length === 1) {
    const resultIndex = fnCtx.nextLocalIndex;
    fnCtx.nextLocalIndex += 1;
    fnCtx.locals.push(resultType);
    return ctx.mod.block(
      null,
      [
        ctx.mod.local.set(resultIndex, value),
        ...operations,
        ctx.mod.local.get(resultIndex, resultType),
      ],
      resultType,
    );
  }

  const captured = captureMultivalueLanes({
    value,
    abiTypes: resultTypes,
    ctx,
    fnCtx,
  });
  return ctx.mod.block(
    null,
    [
      ...captured.setup,
      ...operations,
      ctx.mod.tuple.make(captured.lanes as binaryen.ExpressionRef[]),
    ],
    resultType,
  );
};
