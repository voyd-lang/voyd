import { AST } from "../parser";

export type SyntaxMacro = (ast: AST) => AST;
