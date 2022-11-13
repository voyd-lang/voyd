import { infix } from "./infix";
import { parentheticalElision } from "./parenthetical-elision";
import { Macro } from "./types";

export const macros: Macro[] = [parentheticalElision, infix];
