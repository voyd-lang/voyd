import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  mapBinaryenType,
} from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import {
  refCast,
  refTest,
  structGetFieldValue,
  callRef,
} from "../../lib/binaryen-gc/index.js";
import { getClosureFunctionType } from "../compile-closure.js";
import { FnType, Type, voydBaseObject } from "../../syntax-objects/types.js";
import { canonicalType } from "../../semantics/types/canonicalize.js";

export const compileCallClosure = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod, isReturnExpr } = opts;
  const closure = expr.argAt(0)!;
  const expectedType =
    (closure.getAttribute("parameterFnType") as FnType | undefined) ||
    closure.getType();
  if (!expectedType || !expectedType.isFnType()) {
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
  const primaryType = getClosureFunctionType(opts, expectedType);
  let secondaryType: number | undefined;
  const closureType = closure.getType();
  if (closureType !== expectedType && closureType?.isFnType()) {
    secondaryType = getClosureFunctionType(opts, closureType);
  }
  // Normalize return to base object when objectish (object/union/intersection/alias)
  const retType: Type = expectedType.returnType!;
  const retCanon = canonicalType(retType);
  const isObjectish =
    retCanon?.isObj?.() ||
    retCanon?.isUnionType?.() ||
    retCanon?.isIntersectionType?.() ||
    retCanon?.isTypeAlias?.();
  const returnType = isObjectish
    ? mapBinaryenType(opts, voydBaseObject)
    : mapBinaryenType(opts, expectedType.returnType!);
  let callExpr: number;
  if (secondaryType && secondaryType !== primaryType) {
    // Dynamically pick the matching typed funcref to avoid traps when the
    // closure's compiled __fn uses a different (but structurally compatible)
    // heap type than the call site expects.
    const thenCall = callRef(
      mod,
      refCast(mod, funcRef, primaryType),
      args,
      returnType,
      false
    );
    const elseCall = callRef(
      mod,
      refCast(mod, funcRef, secondaryType),
      args,
      returnType,
      false
    );
    callExpr = mod.if(refTest(mod, funcRef, primaryType), thenCall, elseCall);
  } else {
    try {
      target = refCast(mod, funcRef, primaryType);
    } catch {}
    callExpr = callRef(mod, target, args, returnType, false);
  }
  // Refine return to the precise expected type so downstream static typing
  // matches call_ref's declared result.
  if (isObjectish) {
    const preciseRet = mapBinaryenType(opts, expectedType.returnType!);
    callExpr = refCast(mod, callExpr, preciseRet);
  }
  return isReturnExpr && returnType !== binaryen.none
    ? mod.return(callExpr)
    : callExpr;
};
