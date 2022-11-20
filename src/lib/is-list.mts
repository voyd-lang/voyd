import { AST, Expr } from "../parser.mjs";

export const isList = (expr: Expr): expr is AST => expr instanceof Array;
