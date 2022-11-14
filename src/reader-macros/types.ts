import { AST } from "../parser";

export interface ReaderMacro {
  tag: string;
  macro: (
    dream: string[],
    reader: (dream: string[], terminator?: string) => AST
  ) => AST;
}
