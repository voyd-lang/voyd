import { functionalNotation } from "./functional-notation";
import { infix } from "./infix";
import { parentheticalElision } from "./parenthetical-elision";
import { SyntaxMacro } from "./types";

export const syntaxMacros: SyntaxMacro[] = [
  functionalNotation,
  parentheticalElision,
  infix,
];
