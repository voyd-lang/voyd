import { CompileExprOpts, compileExpression } from "../assembler.js";
import { Call } from "../syntax-objects/call.js";
import { compileAssign } from "./compile-assign.js";
import { compileIf } from "./compile-if.js";
import { compileExport } from "./compile-export.js";
import { compileMemberAccess } from "./compile-member-access.js";
import { compileWhile } from "./compile-while.js";
import { compileFixedArray } from "./compile-fixed-array.js";
import { compileBinaryen } from "./compile-binaryen.js";

export type CallCompiler = (opts: CompileExprOpts<Call>) => number;

export const builtinCallCompilers = new Map<string, CallCompiler>([
  ["quote", (opts) => (opts.expr.argAt(0) as any).value],
  ["=", compileAssign],
  ["if", compileIf],
  ["export", compileExport],
  ["mod", (opts) => opts.mod.nop()],
  ["member-access", compileMemberAccess],
  ["while", compileWhile],
  ["break", (opts) => opts.mod.br(opts.loopBreakId!)],
  ["FixedArray", compileFixedArray],
  ["binaryen", compileBinaryen],
  [
    ":",
    (opts) =>
      compileExpression({
        ...opts,
        expr: opts.expr.argAt(1)!,
        isReturnExpr: opts.isReturnExpr,
      }),
  ],
]);
