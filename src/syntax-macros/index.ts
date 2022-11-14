import { functionalNotation } from "./functional-notation";
import { infix } from "./infix";
import { numbers } from "./numbers";
import { parentheticalElision } from "./parenthetical-elision";
import { SyntaxMacro } from "./types";

export const syntaxMacros: SyntaxMacro[] = [
  functionalNotation,
  parentheticalElision,
  infix,
  numbers,
];
