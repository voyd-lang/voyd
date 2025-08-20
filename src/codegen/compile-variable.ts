import { CompileExprOpts, compileExpression } from "../codegen.js";
import { Variable } from "../syntax-objects/variable.js";

export const compile = (opts: CompileExprOpts<Variable>) => {
  const { expr, mod } = opts;
  return mod.local.set(
    expr.getIndex(),
    expr.initializer
      ? compileExpression({ ...opts, expr: expr.initializer })
      : mod.nop()
  );
};

