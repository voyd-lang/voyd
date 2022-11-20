import { AST, Expr } from "../parser.mjs";

export interface ReaderMacro {
  tag: string | RegExp;
  macro: (
    dream: string[],
    tag: string,
    reader: (dream: string[], terminator?: string) => Expr
  ) => Expr;
}
