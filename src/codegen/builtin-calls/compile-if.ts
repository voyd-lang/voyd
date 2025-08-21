import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  asStmt,
  mapBinaryenType,
} from "../../codegen.js";
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
  const ifTrue = compileExpression({ ...opts, expr: ifTrueNode });
  const ifFalse =
    ifFalseNode !== undefined
      ? compileExpression({ ...opts, expr: ifFalseNode })
      : undefined;
  const returnType = expr.getType()
    ? mapBinaryenType(opts, expr.getType()!)
    : binaryen.none;
  if (returnType === binaryen.none) {
    return mod.if(
      condition,
      asStmt(mod, ifTrue),
      ifFalse !== undefined ? asStmt(mod, ifFalse) : undefined
    );
  }
  return mod.if(condition, ifTrue, ifFalse);
};
