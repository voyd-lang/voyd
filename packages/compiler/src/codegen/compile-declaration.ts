import { CompileExprOpts, mapBinaryenType } from "../codegen.js";
import { Declaration } from "../syntax-objects/declaration.js";
import { Fn } from "../syntax-objects/fn.js";
import { getFunctionParameterTypes } from "./compile-function.js";

export const compile = (opts: CompileExprOpts<Declaration>) => {
  const { expr: decl, mod } = opts;

  decl.fns.forEach((expr) =>
    compileExternFn({ ...opts, expr, namespace: decl.namespace })
  );

  return mod.nop();
};

const compileExternFn = (opts: CompileExprOpts<Fn> & { namespace: string }) => {
  const { expr: fn, mod, namespace } = opts;
  const parameterTypes = getFunctionParameterTypes(opts, fn);

  mod.addFunctionImport(
    fn.id,
    namespace,
    fn.getNameStr(),
    parameterTypes,
    mapBinaryenType(opts, fn.getReturnType())
  );

  return mod.nop();
};

