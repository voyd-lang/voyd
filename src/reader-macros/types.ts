import { AST } from "../parser";

export interface ReaderMacro {
  tag: string | RegExp;
  macro: (
    dream: string[],
    tag: string,
    reader: (dream: string[], terminator?: string) => AST
  ) => AST;
}
