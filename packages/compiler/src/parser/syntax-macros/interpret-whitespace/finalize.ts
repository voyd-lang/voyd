import { Expr } from "../../ast/index.js";
import { attachLabeledClosureSugarHandlers } from "./handler-sugar.js";
import { hoistTrailingBlock } from "./trailing-block.js";

/**
 * Applies whitespace-adjacent rewrites that should run after indentation has
 * been converted into explicit block forms.
 */
export const finalizeWhitespace = (expr: Expr): Expr =>
  hoistTrailingBlock(attachLabeledClosureSugarHandlers(expr));

