import { CompileExprOpts } from "../assembler.js";
import { TraitType } from "../syntax-objects/types/trait.js";

export const compile = (_: CompileExprOpts<TraitType>) => _.mod.nop();
