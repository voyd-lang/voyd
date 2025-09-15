import { CompileExprOpts, compileExpression } from "../codegen.js";
import { Call } from "../syntax-objects/call.js";
import { compileAssign } from "./builtin-calls/compile-assign.js";
import { compileCond } from "./builtin-calls/compile-cond.js";
import { compileExport } from "./builtin-calls/compile-export.js";
import { compileMemberAccess } from "./builtin-calls/compile-member-access.js";
import { compileWhile } from "./builtin-calls/compile-while.js";
import { compileFixedArray } from "./builtin-calls/compile-fixed-array.js";
import { compileBinaryen } from "./builtin-calls/compile-binaryen.js";
import { compileCallClosure } from "./builtin-calls/compile-call-closure.js";

export type CallCompiler = (opts: CompileExprOpts<Call>) => number;

export const builtinCallCompilers = new Map<string, CallCompiler>([
  ["=", compileAssign],
  ["cond", compileCond],
  ["export", compileExport],
  ["mod", (opts) => opts.mod.nop()],
  ["member-access", compileMemberAccess],
  ["while", compileWhile],
  ["break", (opts) => opts.mod.br(opts.loopBreakId!)],
  ["FixedArray", compileFixedArray],
  ["binaryen", compileBinaryen],
  ["call-closure", compileCallClosure],
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
