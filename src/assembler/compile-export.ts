import { CompileExprOpts, compileExpression } from "../assembler.js";
import { Call } from "../syntax-objects/call.js";

export const compileExport = (opts: CompileExprOpts<Call>) => {
  const expr = opts.expr.exprArgAt(0);
  return compileExpression({ ...opts, expr });
};
