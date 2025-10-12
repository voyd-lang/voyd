import {
  CompileExprOpts,
  mapBinaryenType,
  compileExpression,
  asStmt,
} from "../codegen.js";
import { Fn } from "../syntax-objects/fn.js";
import binaryen from "binaryen";

// Track functions already emitted per module to avoid duplicate additions
// This is a band-aid for a bug in the impl resolver.
const compiledFns = new WeakMap<object, Set<string>>();
const getCompiledSet = (mod: object): Set<string> => {
  let set = compiledFns.get(mod);
  if (!set) {
    set = new Set();
    compiledFns.set(mod, set);
  }
  return set;
};

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

  if (!fn.body) {
    return mod.nop();
  }

  const parameterTypes = getFunctionParameterTypes(opts, fn);
  const returnType = mapBinaryenType(opts, fn.getReturnType());

  const compiledSet = getCompiledSet(mod);
  if (compiledSet.has(fn.id)) return mod.nop();
  compiledSet.add(fn.id);

  try {
    const bodyExpr = compileExpression({
      ...opts,
      expr: fn.body!,
      isReturnExpr: returnType !== binaryen.none,
    });
    const body =
      returnType === binaryen.none ? asStmt(mod, bodyExpr) : bodyExpr;

    const variableTypes = getFunctionVarTypes(opts, fn);

    mod.addFunction(fn.id, parameterTypes, returnType, variableTypes, body);
  } catch (error) {
    compiledSet.delete(fn.id);
    throw error;
  }

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
