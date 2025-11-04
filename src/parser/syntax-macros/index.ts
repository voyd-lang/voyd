import { List } from "../../syntax-objects/list.js";
import { functionalNotation } from "./functional-notation.js";
import { interpretWhitespace } from "./interpret-whitespace.js";
import { primary } from "./primary.js";
import { SyntaxMacro } from "./types.js";

/** Caution: Order matters */
const syntaxMacros: SyntaxMacro[] = [
  functionalNotation,
  interpretWhitespace,
  primary,
];

export const expandSyntaxMacros = (expr: List): List =>
  syntaxMacros.reduce((ast, macro) => macro(ast), expr);
