import { call, Form, isForm } from "../../ast/index.js";
import * as p from "../../ast/predicates.js";
import { interpretWhitespaceExpr } from "./interpret-expr.js";
import { applyFunctionalNotation } from "./functional-notation.js";
import { finalizeWhitespace } from "./finalize.js";

/**
 * Rewrites whitespace (newlines/indentation) into explicit `block(...)` forms and
 * applies higher-level whitespace-driven sugars.
 */
export const interpretWhitespace = (form: Form, indentLevel?: number): Form => {
  if (form.callsInternal("ast")) {
    const result = interpretWhitespace(form.slice(1), indentLevel);
    const normalized = call(
      "ast",
      ...(isForm(result.at(0)) ? result.toArray() : [result])
    );
    return finalizeWhitespace(normalized) as Form;
  }

  const functional = applyFunctionalNotation(form);
  const result = interpretWhitespaceExpr(functional, indentLevel);
  return p.isForm(result) ? result : new Form([result]);
};
