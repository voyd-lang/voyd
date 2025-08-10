import { CompileExprOpts } from "../assembler.js";
import { Int } from "../syntax-objects/int.js";

export const compile = (opts: CompileExprOpts<Int>) => {
  const val = opts.expr.value;
  if (typeof val === "number") {
    return opts.mod.i32.const(val);
  }

  const i64Int = val.value;
  const low = Number(i64Int & BigInt(0xffffffff));
  const high = Number((i64Int >> BigInt(32)) & BigInt(0xffffffff));
  return opts.mod.i64.const(low, high);
};

