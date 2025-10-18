import { CompileExprOpts } from "../codegen.js";
import { TraitType } from "../syntax-objects/trait.js";

export const compile = (_: CompileExprOpts<TraitType>) => _.mod.nop();
