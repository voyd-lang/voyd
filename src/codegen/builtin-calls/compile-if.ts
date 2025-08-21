import { CompileExprOpts, compileExpression } from "../../codegen.js";
import { asStmt } from "../../lib/as-stmt.js";
import { Call } from "../../syntax-objects/call.js";

export const compileIf = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const conditionNode = expr.exprArgAt(0);
  const ifTrueNode = expr.labeledArg("then");
  const ifFalseNode = expr.optionalLabeledArg("else");
  const condition = compileExpression({
    ...opts,
    expr: conditionNode,
    isReturnExpr: false,
  });
  const ifTrueExpr = compileExpression({
    ...opts,
    expr: ifTrueNode,
    isReturnExpr: opts.isReturnExpr,
  });
  const ifFalseExpr =
    ifFalseNode !== undefined
      ? compileExpression({
          ...opts,
          expr: ifFalseNode,
          isReturnExpr: opts.isReturnExpr,
        })
      : undefined;

  const ifTrue = opts.isReturnExpr
    ? ifTrueExpr
    : asStmt(mod, ifTrueExpr);
  const ifFalse =
    ifFalseExpr === undefined
      ? undefined
      : opts.isReturnExpr
      ? ifFalseExpr
      : asStmt(mod, ifFalseExpr);

  return mod.if(condition, ifTrue, ifFalse);
};
