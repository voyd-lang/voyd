import { CompileExprOpts } from "../assembler.js";
import { Trait } from "../syntax-objects/trait.js";

export const compile = (_: CompileExprOpts<Trait>) => _.mod.nop();

