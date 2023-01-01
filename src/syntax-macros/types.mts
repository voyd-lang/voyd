import { ModuleInfo } from "../lib/module-info.mjs";
import { List } from "../lib/syntax/syntax.mjs";

export type SyntaxMacro = (list: List, module: ModuleInfo) => List;
