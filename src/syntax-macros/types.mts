import { ModuleInfo } from "../lib/module-info.mjs";
import { AST } from "../parser.mjs";

export type SyntaxMacro = (ast: AST, module: ModuleInfo) => AST;
