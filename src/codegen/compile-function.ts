import { CompileExprOpts, mapBinaryenType, compileExpression } from "../codegen.js";
import { Fn } from "../syntax-objects/fn.js";
import binaryen from "binaryen";
import { asStmt } from "../lib/binaryen-gc/index.js";

export const compile = (opts: CompileExprOpts<Fn>): number => {
  const { expr: fn, mod } = opts;
  if (fn.genericInstances) {
    fn.genericInstances.forEach((instance) =>
      compile({ ...opts, expr: instance })
    );
    return mod.nop();
  }

  if (fn.typeParameters) {
    return mod.nop();
  }

  const parameterTypes = getFunctionParameterTypes(opts, fn);
  const returnType = mapBinaryenType(opts, fn.getReturnType());

  let body = compileExpression({
    ...opts,
    expr: fn.body!,
    isReturnExpr: returnType !== binaryen.none,
    tailCallType: returnType !== binaryen.none ? returnType : undefined,
  });
  if (returnType === binaryen.none) {
    body = asStmt(mod, body);
  }

  const variableTypes = getFunctionVarTypes(opts, fn);

  mod.addFunction(fn.id, parameterTypes, returnType, variableTypes, body);

  return mod.nop();
};

export const getFunctionParameterTypes = (opts: CompileExprOpts, fn: Fn) => {
  const types = fn.parameters.map((param) =>
    mapBinaryenType(opts, param.type!)
  );

  return binaryen.createType(types);
};

export const getFunctionVarTypes = (opts: CompileExprOpts, fn: Fn) =>
  fn.variables.map((v) => mapBinaryenType(opts, v.type!));

