import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  mapBinaryenType,
} from "../codegen.js";
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
import { voydBaseObject } from "../syntax-objects/types.js";
import { murmurHash3 } from "../lib/murmur-hash.js";
import { AugmentedBinaryen } from "../lib/binaryen-gc/types.js";
const bin = binaryen as unknown as AugmentedBinaryen;

export const compile = (opts: CompileExprOpts<Call>): number => {
  const { expr, mod, isReturnExpr } = opts;

  const compiler = builtinCallCompilers.get(expr.fnName.value);
  if (compiler) {
    return compiler(opts);
  }

  // Compile closure calls. TODO: extract this + make it more clear on the call that we are calling a closure
  if (!expr.fn && expr.fnName.type?.isFnType()) {
    const fnType = expr.fnName.type;
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
    const args = [
      closureRef,
      ...expr.args
        .toArray()
        .map((arg) =>
          compileExpression({ ...opts, expr: arg, isReturnExpr: false })
        ),
    ];
    let target = funcRef;
    try {
      const callType = getClosureFunctionType(opts, fnType);
      target = refCast(mod, funcRef, callType);
    } catch {}
    const returnType = mapBinaryenType(opts, fnType.returnType!);
    const callExpr = callRef(mod, target, args, returnType, false);
    return isReturnExpr && returnType !== binaryen.none
      ? mod.return(callExpr)
      : callExpr;
  }

  if (!expr.fn) {
    throw new Error(`No function found for call ${expr.location}`);
  }

  if (expr.fn.isObjectType()) {
    return compileObjectInit(opts);
  }

  if (
    expr.fn.isFn() &&
    expr.fn.parentTrait &&
    expr.argAt(0)?.getType()?.isTraitType()
  ) {
    const traitFn = expr.fn as Fn;
    const obj = expr.argAt(0)!;
    const lookupTable = structGetFieldValue({
      mod,
      fieldType: opts.methodLookupHelpers.lookupTableType,
      fieldIndex: 2,
      exprRef: compileExpression({ ...opts, expr: obj, isReturnExpr: false }),
    });
    const funcRef = mod.call(
      opts.methodLookupHelpers.LOOKUP_NAME,
      [mod.i32.const(murmurHash3(traitFn.id)), lookupTable],
      binaryen.funcref
    );
    let fnType = traitFn.getAttribute("binaryenType") as number | undefined;
    if (!fnType) {
      const paramTypes = bin.createType([
        mapBinaryenType(opts, voydBaseObject),
        ...traitFn.parameters
          .slice(1)
          .map((p) => mapBinaryenType(opts, p.type!)),
      ]);
      const retType = mapBinaryenType(opts, traitFn.returnType!);
      const temp = mod.addFunction(
        `__tmp_trait_${traitFn.id}`,
        paramTypes,
        retType,
        [],
        mod.nop()
      );
      const heapType = bin._BinaryenFunctionGetType(temp);
      fnType = bin._BinaryenTypeFromHeapType(heapType, false);
      traitFn.setAttribute("binaryenType", fnType);
      mod.removeFunction(`__tmp_trait_${traitFn.id}`);
    }
    const target = refCast(mod, funcRef, fnType);
    const args = expr.args.toArray().map((arg, i) => {
      const compiled = compileExpression({
        ...opts,
        expr: arg,
        isReturnExpr: false,
      });
      const param = traitFn.parameters[i];
      const argType = arg.getType();
      if (param?.type?.isObjectType() && argType?.isTraitType()) {
        return refCast(mod, compiled, mapBinaryenType(opts, param.type));
      }
      return compiled;
    });
    const returnType = mapBinaryenType(opts, traitFn.returnType!);
    const callExpr = callRef(mod, target, args, returnType);
    return isReturnExpr && returnType !== binaryen.none
      ? mod.return(callExpr)
      : callExpr;
  }

  const args = expr.args.toArray().map((arg, i) =>
    compileExpression({
      ...opts,
      expr: arg,
      isReturnExpr: false,
    })
  );

  const fn = expr.fn as Fn;
  const id = fn.id;
  const returnType = mapBinaryenType(opts, fn.returnType!);

  if (isReturnExpr) {
    return returnCall(mod, id, args, returnType);
  }

  return mod.call(id, args, returnType);
};
