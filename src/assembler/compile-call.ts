import {
  CompileExprOpts,
  compileExpression,
  mapBinaryenType,
} from "../assembler.js";
import { refCast, structGetFieldValue } from "../lib/binaryen-gc/index.js";
import { Call } from "../syntax-objects/call.js";
import { returnCall } from "./return-call.js";
import { builtinCallCompilers } from "./builtin-call-registry.js";
import { compileObjectInit } from "./compile-object-init.js";
import * as gc from "../lib/binaryen-gc/index.js";
import { FnType } from "../syntax-objects/types.js";
import binaryen from "binaryen";

export const compile = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod, isReturnExpr } = opts;

  const compiler = builtinCallCompilers.get(expr.fnName.value);
  if (compiler) {
    return compiler(opts);
  }

  if (!expr.fn) {
    const fnType = expr.fnName.getType();
    if (fnType?.isFnType()) {
      return compileClosureCall({ ...opts, expr }, fnType);
    }
    throw new Error(`No function found for call ${expr.location}`);
  }

  if (expr.fn.isObjectType()) {
    return compileObjectInit(opts);
  }

  const args = expr.args.toArray().map((arg, i) => {
    const compiled = compileExpression({
      ...opts,
      expr: arg,
      isReturnExpr: false,
    });

    if (!expr.fn?.isFn()) return compiled;
    const param = expr.fn?.parameters[i];
    const argType = arg.getType();
    if (param?.type?.isObjectType() && argType?.isTraitType()) {
      return refCast(mod, compiled, mapBinaryenType(opts, param.type));
    }

    return compiled;
  });

  const id = expr.fn!.id;
  const returnType = mapBinaryenType(opts, expr.fn!.returnType!);

  if (isReturnExpr) {
    return returnCall(mod, id, args, returnType);
  }

  return mod.call(id, args, returnType);
};

const compileClosureCall = (
  opts: CompileExprOpts<Call>,
  fnType: FnType
): number => {
  const { expr, mod, isReturnExpr } = opts;
  const closureRef = compileExpression({
    ...opts,
    expr: expr.fnName,
    isReturnExpr: false,
  });

  const fnRef = gc.structGetFieldValue({
    mod,
    fieldType: binaryen.funcref,
    fieldIndex: 0,
    exprRef: compileExpression({
      ...opts,
      expr: expr.fnName,
      isReturnExpr: false,
    }),
  });

  const typedFnRef = gc.refCast(
    mod,
    fnRef,
    fnType.getAttribute("binaryenFnRefType") as binaryen.Type
  );

  const args = [
    closureRef,
    ...expr.args
      .toArray()
      .map((arg) =>
        compileExpression({ ...opts, expr: arg, isReturnExpr: false })
      ),
  ];

  const returnType = mapBinaryenType(opts, fnType.returnType);

  return gc.callRef(mod, typedFnRef, args, returnType, false);
};
