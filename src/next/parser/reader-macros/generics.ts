import { isIdentifierAtom } from "../ast/predicates.js";
import { prefixCall } from "./lib/init-helpers.js";
import { ReaderMacro } from "./types.js";

export const genericsMacro: ReaderMacro = {
  match: (t, prev) => {
    return t.value === "<" && !!isIdentifierAtom(prev);
  },
  macro: (file, { reader }) => {
    const items = reader(file, ">");
    return prefixCall("generics", ...items.toArray());
  },
};
