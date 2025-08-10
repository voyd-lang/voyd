import { CompileExprOpts } from "../assembler.js";
import { Macro } from "../syntax-objects/macros.js";

export const compile = (_: CompileExprOpts<Macro>) => _.mod.nop();

