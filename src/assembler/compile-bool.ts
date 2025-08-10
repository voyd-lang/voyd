import { CompileExprOpts } from "../assembler.js";
import { Bool } from "../syntax-objects/bool.js";

export const compile = (opts: CompileExprOpts<Bool>) => {
  return opts.expr.value ? opts.mod.i32.const(1) : opts.mod.i32.const(0);
};

