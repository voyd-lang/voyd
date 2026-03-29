import binaryen from "binaryen";
import { initStruct, refCast, structGetFieldValue } from "@voyd-lang/lib/binaryen-gc/index.js";
import type { CodegenContext, FunctionContext, TypeId } from "./context.js";
import {
  abiTypeFor,
  getDirectAbiTypesForSignature,
  getSignatureSpillBoxType,
} from "./types.js";
import { captureMultivalueLanes } from "./multivalue.js";

const makeInlineValue = ({
  values,
  ctx,
}: {
  values: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (values.length === 0) {
    return ctx.mod.nop();
  }
  if (values.length === 1) {
    return values[0]!;
  }
  return ctx.mod.tuple.make(values as binaryen.ExpressionRef[]);
};

export const boxSignatureSpillValue = ({
  value,
  typeId,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const boxType = getSignatureSpillBoxType({ typeId, ctx });
  if (!boxType) {
    return value;
  }
  const valueType = binaryen.getExpressionType(value);
  if (valueType === boxType || valueType === binaryen.unreachable) {
    return value;
  }
  const abiTypes = getDirectAbiTypesForSignature(typeId, ctx);
  const captured = captureMultivalueLanes({
    value,
    abiTypes,
    ctx,
    fnCtx,
  });
  const boxed = initStruct(
    ctx.mod,
    boxType,
    captured.lanes as binaryen.ExpressionRef[],
  );
  if (captured.setup.length === 0) {
    return boxed;
  }
  return ctx.mod.block(null, [...captured.setup, boxed], boxType);
};

export const unboxSignatureSpillValue = ({
  value,
  typeId,
  ctx,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const boxType = getSignatureSpillBoxType({ typeId, ctx });
  if (!boxType) {
    return value;
  }
  const valueType = binaryen.getExpressionType(value);
  if (valueType !== boxType) {
    return value;
  }
  const abiTypes = getDirectAbiTypesForSignature(typeId, ctx);
  return makeInlineValue({
    values: abiTypes.map((abiType, index) =>
      structGetFieldValue({
        mod: ctx.mod,
        fieldType: abiType,
        fieldIndex: index,
        exprRef: refCast(ctx.mod, value, boxType),
      }),
    ),
    ctx,
  });
};

export const isSignatureSpillStorage = ({
  typeId,
  storageType,
  ctx,
}: {
  typeId: TypeId;
  storageType: binaryen.Type;
  ctx: CodegenContext;
}): boolean => getSignatureSpillBoxType({ typeId, ctx }) === storageType;

export const signatureSpillStorageType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): binaryen.Type => {
  const boxType = getSignatureSpillBoxType({ typeId, ctx });
  return boxType ?? abiTypeFor(getDirectAbiTypesForSignature(typeId, ctx));
};
