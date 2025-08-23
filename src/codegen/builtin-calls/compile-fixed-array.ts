import { CompileExprOpts, compileExpression, mapBinaryenType } from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import { FixedArrayType } from "../../syntax-objects/types.js";
import * as gc from "../../lib/binaryen-gc/index.js";

export const compileFixedArray = (opts: CompileExprOpts<Call>) => {
  const type = opts.expr.type as FixedArrayType;
  const elemType = type.elemType!;
  const elemBinaryenType = mapBinaryenType(opts, elemType);
  const values = opts.expr.argArrayMap((expr) => {
    const compiled = compileExpression({ ...opts, expr });
    return elemType.isRefType()
      ? gc.refCast(opts.mod, compiled, elemBinaryenType)
      : compiled;
  });
  const arrayType = mapBinaryenType(opts, type);
  return gc.arrayNewFixed(
    opts.mod,
    gc.binaryenTypeToHeapType(arrayType),
    values
  );
};
