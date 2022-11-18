import { AST } from "../parser.mjs";

export type SyntaxMacro = (ast: AST) => AST;
