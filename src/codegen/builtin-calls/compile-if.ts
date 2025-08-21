import { CompileExprOpts, compileExpression } from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import { asStmt } from "../../lib/binaryen-gc/index.js";

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
  const ifTrue = compileExpression({
    ...opts,
    expr: ifTrueNode,
    isReturnExpr: opts.isReturnExpr,
  });
  const ifFalse =
    ifFalseNode !== undefined
      ? compileExpression({
          ...opts,
          expr: ifFalseNode,
          isReturnExpr: opts.isReturnExpr,
        })
      : undefined;

  return opts.isReturnExpr
    ? mod.if(condition, ifTrue, ifFalse)
    : mod.if(
        condition,
        asStmt(mod, ifTrue),
        ifFalse !== undefined ? asStmt(mod, ifFalse) : undefined
      );
};
