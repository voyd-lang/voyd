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
import {
  getClosureBaseType,
  getFnBinaryenType,
} from "./compile-closure.js";

export const compile = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod, isReturnExpr } = opts;

  const compiler = builtinCallCompilers.get(expr.fnName.value);
  if (compiler) {
    return compiler(opts);
  }

  if (!expr.fn) {
    const entity = expr.fnName.resolve() as any;
    const fnType = entity?.type;
    if (fnType && fnType.isFnType && fnType.isFnType()) {
      const closureRef = compileExpression({
        ...opts,
        expr: expr.fnName,
        isReturnExpr: false,
      });
      const baseType = getClosureBaseType(mod);
      const fnPtr = structGetFieldValue({
        mod,
        fieldType: binaryen.funcref,
        fieldIndex: 0,
        exprRef: refCast(mod, closureRef, baseType),
      });
      const fnRefType = getFnBinaryenType(opts, fnType);
      const args = expr.args.toArray().map((arg, i) => {
        const compiled = compileExpression({
          ...opts,
          expr: arg,
          isReturnExpr: false,
        });
        const param = fnType.parameters[i];
        const argType = arg.getType();
        if (param?.type?.isObjectType() && argType?.isTraitType()) {
          return refCast(mod, compiled, mapBinaryenType(opts, param.type));
        }
        return compiled;
      });
      const callArgs = [closureRef, ...args];
      const returnType = mapBinaryenType(opts, fnType.returnType);
      const callExpr = callRef(
        mod,
        refCast(mod, fnPtr, fnRefType),
        callArgs,
        returnType
      );
      if (isReturnExpr) return mod.return(callExpr);
      return callExpr;
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
