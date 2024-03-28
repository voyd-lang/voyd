import { List } from "../../syntax-objects/index.mjs";
import { functionalNotation } from "./functional-notation.mjs";
import { interpretWhitespace } from "./interpret-whitespace.mjs";
import { SyntaxMacro } from "../types.mjs";
import { primary } from "./primary.mjs";

/** Caution: Order matters */
const surfaceLanguageMacros: SyntaxMacro[] = [
  functionalNotation,
  interpretWhitespace,
  // primary,
];

/** Transforms the surface language into the core language */
export const surfaceLanguage = (parserOutput: List) =>
  surfaceLanguageMacros.reduce((ast, macro) => macro(ast), parserOutput);
