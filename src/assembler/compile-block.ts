import { CompileExprOpts, compileExpression } from "../assembler.js";
import { Block } from "../syntax-objects/block.js";

export const compile = (opts: CompileExprOpts<Block>) => {
  return opts.mod.block(
    null,
    opts.expr.body.map((expr, index, array) => {
      if (index === array.length - 1 && opts.isReturnExpr) {
        return compileExpression({ ...opts, expr, isReturnExpr: true });
      }

      return compileExpression({ ...opts, expr, isReturnExpr: false });
    })
  );
};

