import binaryen from "binaryen";
import { CompileExprOpts, compileExpression, asStmt } from "../codegen.js";
import { Block } from "../syntax-objects/block.js";

export const compile = (opts: CompileExprOpts<Block>) => {
  const { expr, mod } = opts;
  const children = expr.body.map((child, index, array) => {
    const compiled = compileExpression({
      ...opts,
      expr: child,
      isReturnExpr: opts.isReturnExpr && index === array.length - 1,
    });
    return index === array.length - 1 ? compiled : asStmt(mod, compiled);
  });
  return mod.block(null, children, binaryen.auto);
};

