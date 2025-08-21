import binaryen from "binaryen";
import { CompileExprOpts, compileExpression } from "../codegen.js";
import { asStmt } from "../lib/as-stmt.js";
import { Block } from "../syntax-objects/block.js";

export const compile = (opts: CompileExprOpts<Block>) => {
  const { mod, expr } = opts;
  const children = expr.body.map((expr, index, array) => {
    const isLast = index === array.length - 1;
    const compiled = compileExpression({
      ...opts,
      expr,
      isReturnExpr: opts.isReturnExpr && isLast,
    });
    return !opts.isReturnExpr || !isLast ? asStmt(mod, compiled) : compiled;
  });

  const type = opts.isReturnExpr ? binaryen.auto : binaryen.none;
  return mod.block(null, children, type);
};

