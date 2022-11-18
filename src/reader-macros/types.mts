import { AST } from "../parser.mjs";

export interface ReaderMacro {
  tag: string | RegExp;
  macro: (
    dream: string[],
    tag: string,
    reader: (dream: string[], terminator?: string) => AST
  ) => AST;
}
