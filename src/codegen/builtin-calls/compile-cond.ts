import binaryen from "binaryen";
import {
  CompileExprOpts,
  compileExpression,
  asStmt,
  mapBinaryenType,
} from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";
import { ObjectLiteral } from "../../syntax-objects/object-literal.js";

export const compileCond = (opts: CompileExprOpts<Call>) => {
  const { expr, mod } = opts;
  const args = expr.args.toArray();
  const defaultExpr = args.at(-1)?.hasAttribute("condDefault")
    ? args.pop()
    : undefined;

  const returnType = expr.getType()
    ? mapBinaryenType(opts, expr.getType()!)
    : binaryen.none;

  let elseNode =
    defaultExpr !== undefined
      ? compileExpression({ ...opts, expr: defaultExpr })
      : undefined;

  for (let i = args.length - 1; i >= 0; i--) {
    const pair = args[i] as ObjectLiteral;
    const condExpr = pair.fields.find((f) => f.name === "case")!.initializer;
    const thenExpr = pair.fields.find((f) => f.name === "do")!.initializer;
    const condition = compileExpression({
      ...opts,
      expr: condExpr,
      isReturnExpr: false,
    });
    const ifTrue = compileExpression({ ...opts, expr: thenExpr });
    elseNode =
      returnType === binaryen.none
        ? mod.if(
            condition,
            asStmt(mod, ifTrue),
            elseNode !== undefined ? asStmt(mod, elseNode) : undefined
          )
        : mod.if(condition, ifTrue, elseNode);
  }

  return elseNode!;
};
