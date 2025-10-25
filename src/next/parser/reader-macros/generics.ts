import { isIdentifier } from "../grammar.js";
import { call } from "./lib/init-helpers.js";
import { ReaderMacro } from "./types.js";

export const genericsMacro: ReaderMacro = {
  match: (t, prev) => {
    return t.value === "<" && !!isIdentifier(prev);
  },
  macro: (file, { reader }) => {
    const items = reader(file, ">");
    return call("generics", ...items.toArray());
  },
};
