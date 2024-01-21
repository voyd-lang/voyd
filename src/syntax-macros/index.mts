import { getConfig } from "../config/index.mjs";
import { macro } from "./regular-macros.mjs";
import { moduleSyntaxMacro } from "./module.mjs";
import { typeCheck } from "./type-analysis/index.mjs";
import { SyntaxMacro } from "./types.mjs";
export { desugar } from "./surface-language/index.mjs";

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

const macroPhaseSyntaxMacros: SyntaxMacro[] = [
  ...deSugarSyntaxMacros,
  moduleSyntaxMacro,
  macro,
];

/** Caution: Order matters */
const standardSyntaxMacros: SyntaxMacro[] = [
  ...macroPhaseSyntaxMacros,
  typeCheck,
];
