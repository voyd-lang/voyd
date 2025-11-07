import { CompileExprOpts, compileExpression, mapBinaryenType } from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import { FixedArrayType } from "../../syntax-objects/types.js";
import * as gc from "@lib/binaryen-gc/index.js";

export const compileFixedArray = (opts: CompileExprOpts<Call>) => {
  const type = opts.expr.type as FixedArrayType;
  return gc.arrayNewFixed(
    opts.mod,
    gc.binaryenTypeToHeapType(mapBinaryenType(opts, type)),
    opts.expr.argArrayMap((expr) => compileExpression({ ...opts, expr }))
  );
};
