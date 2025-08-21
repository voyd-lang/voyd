import binaryen from "binaryen";
import { CompileExprOpts, compileExpression } from "../codegen.js";
import { Block } from "../syntax-objects/block.js";
import { asStmt } from "../lib/binaryen-gc/index.js";

export const compile = (opts: CompileExprOpts<Block>) => {
  const children = opts.expr.body.map((expr, index, array) => {
    const isLast = index === array.length - 1;
    const child = compileExpression({
      ...opts,
      expr,
      isReturnExpr: opts.isReturnExpr && isLast,
    });
    return !opts.isReturnExpr || !isLast ? asStmt(opts.mod, child) : child;
  });

  return opts.mod.block(
    null,
    children,
    opts.isReturnExpr ? binaryen.auto : binaryen.none
  );
};

