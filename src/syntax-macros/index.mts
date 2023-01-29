import { functionalNotation } from "./functional-notation.mjs";
import { processGreedyOps } from "./greedy-ops.mjs";
import { infix } from "./infix.mjs";
import { macro } from "./macro.mjs";
import { memoryManagement } from "./memory-management.mjs";
import { moduleSyntaxMacro } from "./module.mjs";
import { parentheticalElision } from "./parenthetical-elision.mjs";
import { typeAnalysis } from "./type-analysis/index.mjs";
import { SyntaxMacro } from "./types.mjs";

/** Caution: Order matters */
export const syntaxMacros: SyntaxMacro[] = [
  functionalNotation,
  parentheticalElision,
  processGreedyOps,
  (ast) => infix(ast),
  moduleSyntaxMacro,
  macro,
  typeAnalysis,
  memoryManagement,
];
