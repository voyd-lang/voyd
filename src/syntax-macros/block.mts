import { AST } from "../parser.mjs";

/** Converts each file ast into a block (for now) */
export const block = (ast: AST): AST => {
  ast.unshift("block");
  return ast;
};
