import { isIdentifierAtom } from "../ast/predicates.js";
import { ReaderMacro } from "./types.js";

export const genericsMacro: ReaderMacro = {
  match: (t, prev) => {
    return t.value === "<" && isIdentifierAtom(prev);
  },
  macro: (file, { reader }) => {
    const items = reader(file, ">");
    return items.splitInto("generics");
  },
};
