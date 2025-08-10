import { CompileExprOpts } from "../assembler.js";
import { Implementation } from "../syntax-objects/implementation.js";

export const compile = (_: CompileExprOpts<Implementation>) => _.mod.nop();

