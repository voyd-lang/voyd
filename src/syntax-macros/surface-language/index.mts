import { List, ModuleInfo } from "../../lib/index.mjs";
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
export const surfaceLanguageMacro = (parserOutput: List, info: ModuleInfo) =>
  surfaceLanguageMacros.reduce((ast, macro) => macro(ast, info), parserOutput);
