import { CompileExprOpts } from "../assembler.js";
import { MacroVariable } from "../syntax-objects/macro-variable.js";

export const compile = (_: CompileExprOpts<MacroVariable>) => _.mod.nop();

