import { Form } from "../ast/form.js";
import { interpretWhitespace } from "./interpret-whitespace.js";
import { intrinsicAttributeMacro } from "./intrinsic-attribute.js";
import { primary } from "./primary.js";
import { SyntaxMacro } from "./types.js";
import { functionalMacroExpander } from "./functional-macro-expander/index.js";

/** Caution: Order matters */
const SYNTAX_MACROS: SyntaxMacro[] = [
  interpretWhitespace,
  primary,
  functionalMacroExpander,
  intrinsicAttributeMacro,
];

export const expandSyntaxMacros = (
  expr: Form,
  syntaxMacros = SYNTAX_MACROS
): Form => syntaxMacros.reduce((ast, macro) => macro(ast), expr);
