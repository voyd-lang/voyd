import { Form } from "../ast/form.js";
import { interpretWhitespace } from "./interpret-whitespace.js";
import { intrinsicAttributeMacro } from "./intrinsic-attribute.js";
import { intrinsicTypeAttributeMacro } from "./intrinsic-type-attribute.js";
import { effectAttributeMacro } from "./effect-attribute.js";
import { primary } from "./primary.js";
import { attachColonClauses } from "./colon-clauses.js";
import { constructorObjectLiteral } from "./constructor-object-literal.js";
import { SyntaxMacro } from "./types.js";
import { functionalMacroExpander } from "./functional-macro-expander/index.js";
import { testBlockMacro } from "./test-block.js";

/** Caution: Order matters */
const SYNTAX_MACROS: SyntaxMacro[] = [
  interpretWhitespace,
  primary,
  attachColonClauses,
  constructorObjectLiteral,
  functionalMacroExpander,
  intrinsicAttributeMacro,
  intrinsicTypeAttributeMacro,
  effectAttributeMacro,
  testBlockMacro,
];

export const expandSyntaxMacros = (
  expr: Form,
  syntaxMacros = SYNTAX_MACROS
): Form => syntaxMacros.reduce((ast, macro) => macro(ast), expr);
