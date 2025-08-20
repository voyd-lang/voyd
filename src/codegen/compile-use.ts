import { CompileExprOpts } from "../codegen.js";
import { Use } from "../syntax-objects/use.js";

export const compile = (_: CompileExprOpts<Use>) => _.mod.nop();

