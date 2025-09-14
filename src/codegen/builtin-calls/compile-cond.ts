import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  asStmt,
  mapBinaryenType,
} from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import { List } from "../../syntax-objects/list.js";

export const compileCond = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const args = expr.args.toArray();
  const defaultExpr = args.at(-1)?.hasAttribute("condDefault")
    ? args.pop()
    : undefined;

  const returnType = expr.getType()
    ? mapBinaryenType(opts, expr.getType()!)
    : binaryen.none;

  let ifNode =
    defaultExpr !== undefined
      ? compileExpression({ ...opts, expr: defaultExpr })
      : undefined;

  for (let i = args.length - 1; i >= 0; i--) {
    const pair = args[i] as List;
    const condExpr = pair.exprAt(0);
    const thenExpr = pair.exprAt(1);
    const condition = compileExpression({
      ...opts,
      expr: condExpr,
      isReturnExpr: false,
    });
    const ifTrue = compileExpression({ ...opts, expr: thenExpr });
    ifNode =
      returnType === binaryen.none
        ? mod.if(
            condition,
            asStmt(mod, ifTrue),
            ifNode !== undefined ? asStmt(mod, ifNode) : undefined
          )
        : mod.if(condition, ifTrue, ifNode);
  }

  return ifNode!;
};
