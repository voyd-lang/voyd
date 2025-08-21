import { CompileExprOpts, compileExpression, asStmt } from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";

export const compileWhile = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const loopId = expr.syntaxId.toString();
  const breakId = `__break_${loopId}`;
  return mod.loop(
    loopId,
    mod.block(breakId, [
      mod.br_if(
        breakId,
        mod.i32.ne(
          compileExpression({
            ...opts,
            expr: expr.exprArgAt(0),
            isReturnExpr: false,
          }),
          mod.i32.const(1)
        )
      ),
      asStmt(
        mod,
        compileExpression({
          ...opts,
          expr: expr.labeledArg("do"),
          loopBreakId: breakId,
          isReturnExpr: false,
        })
      ),
      mod.br(loopId),
    ])
  );
};
