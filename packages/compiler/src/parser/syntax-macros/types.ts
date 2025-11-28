import { List } from "../../syntax-objects/index.js";

/** Takes the whole ast, returns a transformed version of the whole ast */
export type SyntaxMacro = (list: List) => List;
