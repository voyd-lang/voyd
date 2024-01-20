import { getConfig } from "../config/index.mjs";
import { functionalNotation } from "./functional-notation.mjs";
import { processGreedyOps } from "./greedy-ops.mjs";
import { infix } from "./infix.mjs";
import { macro } from "./macro.mjs";
import { moduleSyntaxMacro } from "./module.mjs";
import { parentheticalElision } from "./interpret-whitespace.mjs";
import { typeAnalysis } from "./type-analysis/index.mjs";
import { SyntaxMacro } from "./types.mjs";

export const getSyntaxMacros = (): SyntaxMacro[] => {
  // This is smelly, but will have to do until I figure out a better structure for this.
  if (getConfig().emitDeSugaredAst) {
    return deSugarSyntaxMacros;
  }

  if (getConfig().emitPostMacroAst) {
    return macroPhaseSyntaxMacros;
  }

  return standardSyntaxMacros;
};

/** Caution: Order matters */
const deSugarSyntaxMacros: SyntaxMacro[] = [
  functionalNotation,
  parentheticalElision,
  processGreedyOps,
  (ast) => infix(ast),
];

const macroPhaseSyntaxMacros: SyntaxMacro[] = [
  ...deSugarSyntaxMacros,
  moduleSyntaxMacro,
  macro,
];

/** Caution: Order matters */
const standardSyntaxMacros: SyntaxMacro[] = [
  ...macroPhaseSyntaxMacros,
  typeAnalysis,
];
