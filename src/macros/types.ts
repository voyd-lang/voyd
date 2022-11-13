import { AST } from "../parser";

export type Macro = (ast: AST) => AST;
