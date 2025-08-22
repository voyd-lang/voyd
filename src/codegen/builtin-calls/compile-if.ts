import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  asStmt,
  mapBinaryenType,
} from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import { Expr } from "../../syntax-objects/expr.js";

export const compileIf = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;

  const args = expr.args.toArray();
  const branches: { cond: Expr; then: Expr }[] = [];
  let elseExpr: Expr | undefined;

  let currentCond = args[0]!;
  for (let i = 1; i < args.length; i++) {
    const labelCall = args[i];
    if (!labelCall.isCall() || !labelCall.calls(":")) continue;
    const labelId = labelCall.argAt(0);
    const value = labelCall.exprArgAt(1);
    if (!labelId?.isIdentifier()) continue;
    if (labelId.value === "then") {
      branches.push({ cond: currentCond, then: value });
    } else if (labelId.value === "elif") {
      currentCond = value;
    } else if (labelId.value === "else") {
      elseExpr = value;
    }
  }

  const returnType = expr.getType()
    ? mapBinaryenType(opts, expr.getType()!)
    : binaryen.none;

  let compiledElse =
    elseExpr !== undefined
      ? compileExpression({ ...opts, expr: elseExpr })
      : undefined;

  for (let i = branches.length - 1; i >= 0; i--) {
    const cond = compileExpression({
      ...opts,
      expr: branches[i].cond,
      isReturnExpr: false,
    });
    const thenExpr = compileExpression({ ...opts, expr: branches[i].then });
    compiledElse =
      returnType === binaryen.none
        ? mod.if(
            cond,
            asStmt(mod, thenExpr),
            compiledElse !== undefined ? asStmt(mod, compiledElse) : undefined
          )
        : mod.if(cond, thenExpr, compiledElse);
  }

  return compiledElse!;
};
