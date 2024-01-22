import { List } from "../lib/index.mjs";

/** Takes the whole ast, returns a transformed version of the whole ast */
export type SyntaxMacro = (list: List) => List;
