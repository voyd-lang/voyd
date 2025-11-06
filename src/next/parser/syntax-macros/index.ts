import { Form } from "../ast/form.js";
import { interpretWhitespace } from "./interpret-whitespace.js";
import { primary } from "./primary.js";
import { SyntaxMacro } from "./types.js";
import { functionalMacros } from "./functional-macros.js";

/** Caution: Order matters */
const SYNTAX_MACROS: SyntaxMacro[] = [
  interpretWhitespace,
  primary,
  functionalMacros,
];

export const expandSyntaxMacros = (
  expr: Form,
  syntaxMacros = SYNTAX_MACROS
): Form => syntaxMacros.reduce((ast, macro) => macro(ast), expr);
