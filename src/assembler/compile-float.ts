import { CompileExprOpts } from "../assembler.js";
import { Float } from "../syntax-objects/float.js";

export const compile = (opts: CompileExprOpts<Float>) => {
  const val = opts.expr.value;
  if (typeof val === "number") {
    return opts.mod.f32.const(val);
  }
  return opts.mod.f64.const(val.value);
};

