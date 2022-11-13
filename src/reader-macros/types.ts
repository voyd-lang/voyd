import { AST } from "../parser";

export interface ReaderMacro {
  tag: string;
  macro: (dream: string[]) => AST;
}
