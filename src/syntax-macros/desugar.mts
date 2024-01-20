import { List, ModuleInfo } from "../lib/index.mjs";
import { functionalNotation } from "./functional-notation.mjs";
import { processGreedyOps } from "./greedy-ops.mjs";
import { infix } from "./infix.mjs";
import { interpretWhitespace } from "./interpret-whitespace.mjs";
import { SyntaxMacro } from "./types.mjs";

/** Caution: Order matters */
export const deSugarSyntaxMacros: SyntaxMacro[] = [
  functionalNotation,
  interpretWhitespace,
  processGreedyOps,
  (ast) => infix(ast),
];

export const desugar = (parserOutput: List, info: ModuleInfo) =>
  deSugarSyntaxMacros.reduce((ast, macro) => macro(ast, info), parserOutput);
