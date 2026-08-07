import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  LocalBindingScalarAggregate,
  TypeId,
} from "../context.js";
import { captureMultivalueLanes } from "../multivalue.js";
import { boxSignatureSpillValue } from "../signature-spill.js";
import { abiTypeFor } from "../types.js";
import { loadScalarAggregateBindingAbiLanes } from "./scalar-aggregates.js";

export const packMutableScalarAggregateResult = ({
  logicalValue,
  logicalResultTypeId,
  logicalResultAbiTypes,
  binding,
  ctx,
  fnCtx,
}: {
  logicalValue: binaryen.ExpressionRef;
  logicalResultTypeId: TypeId;
  logicalResultAbiTypes: readonly binaryen.Type[];
  binding: LocalBindingScalarAggregate;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (binaryen.getExpressionType(logicalValue) === binaryen.unreachable) {
    return logicalValue;
  }

  const boxedLogicalValue =
    logicalResultAbiTypes.length === 0
      ? logicalValue
      : boxSignatureSpillValue({
          value: logicalValue,
          typeId: logicalResultTypeId,
          ctx,
          fnCtx,
        });
  const logical = captureMultivalueLanes({
    value: boxedLogicalValue,
    abiTypes: logicalResultAbiTypes,
    ctx,
    fnCtx,
  });
  const resultLanes = [
    ...logical.lanes,
    ...loadScalarAggregateBindingAbiLanes({ binding, ctx }),
  ];
  const result =
    resultLanes.length === 1
      ? resultLanes[0]!
      : ctx.mod.tuple.make(resultLanes as binaryen.ExpressionRef[]);
  const setup =
    logicalResultAbiTypes.length === 0
      ? [logicalValue, ...logical.setup]
      : logical.setup;
  return setup.length === 0
    ? result
    : ctx.mod.block(
        null,
        [...setup, result],
        abiTypeFor(resultLanes.map((lane) => binaryen.getExpressionType(lane))),
      );
};
