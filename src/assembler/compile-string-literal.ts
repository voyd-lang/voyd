import { CompileExprOpts, getI32ArrayType } from "../assembler.js";
import { StringLiteral } from "../syntax-objects/string-literal.js";
import { arrayNewFixed, binaryenTypeToHeapType } from "../lib/binaryen-gc/index.js";

export const compile = (opts: CompileExprOpts<StringLiteral>) => {
  const { expr, mod } = opts;
  return arrayNewFixed(
    mod,
    binaryenTypeToHeapType(getI32ArrayType(mod)),
    expr.value.split("").map((char) => mod.i32.const(char.charCodeAt(0)))
  );
};

