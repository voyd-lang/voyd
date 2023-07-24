import { getConfig } from "../config/index.mjs";
import { functionalNotation } from "./functional-notation.mjs";
import { processGreedyOps } from "./greedy-ops.mjs";
import { infix } from "./infix.mjs";
import { macro } from "./macro.mjs";
import { moduleSyntaxMacro } from "./module.mjs";
import { parentheticalElision } from "./parenthetical-elision.mjs";
import { typeAnalysis } from "./type-analysis/index.mjs";
import { SyntaxMacro } from "./types.mjs";

export const getSyntaxMacros = (): SyntaxMacro[] => {
  // This is smelly, but will have to do until I figure out a better structure for this.
  if (getConfig().emitDeSugaredAst) {
    return deSugarSyntaxMacros;
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

/** Caution: Order matters */
const standardSyntaxMacros: SyntaxMacro[] = [
  ...deSugarSyntaxMacros,
  moduleSyntaxMacro,
  macro,
  typeAnalysis,
];
