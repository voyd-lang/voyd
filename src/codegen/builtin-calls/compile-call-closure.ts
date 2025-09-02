import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  mapBinaryenType,
} from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import {
  refCast,
  structGetFieldValue,
  callRef,
} from "../../lib/binaryen-gc/index.js";
import { getClosureFunctionType } from "../compile-closure.js";

export const compileCallClosure = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod, isReturnExpr } = opts;
  const closure = expr.argAt(0)!;
  const closureType = closure.getType();
  if (!closureType || !closureType.isFnType()) {
    throw new Error("Invalid closure call");
  }
  const closureRef = compileExpression({
    ...opts,
    expr: closure,
    isReturnExpr: false,
  });
  const funcRef = structGetFieldValue({
    mod,
    fieldType: binaryen.funcref,
    fieldIndex: 0,
    exprRef: closureRef,
  });
  const argRefs = expr.args
    .sliceAsArray(1)
    .map((arg) =>
      compileExpression({ ...opts, expr: arg, isReturnExpr: false })
    );
  const args = [closureRef, ...argRefs];
  let target = funcRef;
  try {
    const callType = getClosureFunctionType(opts, closureType);
    target = refCast(mod, funcRef, callType);
  } catch {}
  const returnType = mapBinaryenType(opts, closureType.returnType!);
  const callExpr = callRef(mod, target, args, returnType, false);
  return isReturnExpr && returnType !== binaryen.none
    ? mod.return(callExpr)
    : callExpr;
};
