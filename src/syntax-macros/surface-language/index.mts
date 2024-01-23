import { List } from "../../syntax-objects/index.mjs";
import { functionalNotation } from "./functional-notation.mjs";
import { processGreedyOps } from "./greedy-ops.mjs";
import { infix } from "./infix.mjs";
import { interpretWhitespace } from "./interpret-whitespace.mjs";
import { SyntaxMacro } from "../types.mjs";

/** Caution: Order matters */
const surfaceLanguageMacros: SyntaxMacro[] = [
  functionalNotation,
  interpretWhitespace,
  processGreedyOps,
  (ast) => infix(ast),
];

/** Transforms the surface language into the core language */
export const surfaceLanguage = (parserOutput: List) =>
  surfaceLanguageMacros.reduce((ast, macro) => macro(ast), parserOutput);
