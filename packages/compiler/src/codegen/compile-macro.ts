import { CompileExprOpts } from "../codegen.js";
import { Macro } from "../syntax-objects/macros.js";

export const compile = (_: CompileExprOpts<Macro>) => _.mod.nop();

