import { List } from "../../syntax-objects/index.js";
import { functionalNotation } from "./functional-notation.js";
import { interpretWhitespace } from "./interpret-whitespace.js";
import { SyntaxMacro } from "../types.js";
import { primary } from "./primary.js";

/** Caution: Order matters */
const surfaceLanguageMacros: SyntaxMacro[] = [
  functionalNotation,
  interpretWhitespace,
  primary,
];

/** Transforms the surface language into the core language */
export const surfaceLanguage = (parserOutput: List) =>
  surfaceLanguageMacros.reduce((ast, macro) => macro(ast), parserOutput);
