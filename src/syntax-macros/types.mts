import { List } from "../lib/index.mjs";
import { ModuleInfo } from "../lib/module-info.mjs";

export type SyntaxMacro = (list: List, module: ModuleInfo) => List;
