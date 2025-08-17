import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  mapBinaryenType,
} from "../assembler.js";
import {
  refCast,
  structGetFieldValue,
  callRef,
} from "../lib/binaryen-gc/index.js";
import { Call } from "../syntax-objects/call.js";
import { returnCall } from "./return-call.js";
import { builtinCallCompilers } from "./builtin-call-registry.js";
import { compileObjectInit } from "./compile-object-init.js";
import { getClosureFunctionType } from "./compile-closure.js";
import { Fn } from "../syntax-objects/fn.js";

export const compile = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod, isReturnExpr } = opts;

  const compiler = builtinCallCompilers.get(expr.fnName.value);
  if (compiler) {
    return compiler(opts);
  }

  if (!expr.fn) {
    const fnType = expr.fnName.type;
    if (fnType?.isFnType()) {
      const closureRef = compileExpression({
        ...opts,
        expr: expr.fnName,
        isReturnExpr: false,
      });
      const funcRef = structGetFieldValue({
        mod,
        fieldType: binaryen.funcref,
        fieldIndex: 0,
        exprRef: closureRef,
      });
      const callType = getClosureFunctionType(opts, fnType);
      const args = [
        closureRef,
        ...expr.args
          .toArray()
          .map((arg) =>
            compileExpression({ ...opts, expr: arg, isReturnExpr: false })
          ),
      ];
      const returnType = mapBinaryenType(opts, fnType.returnType);
      return callRef(
        mod,
        refCast(mod, funcRef, callType),
        args,
        returnType,
        isReturnExpr
      );
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

  const fn = expr.fn as Fn;
  const id = fn.id;
  const returnType = mapBinaryenType(opts, fn.returnType!);

  if (isReturnExpr) {
    return returnCall(mod, id, args, returnType);
  }

  return mod.call(id, args, returnType);
};
