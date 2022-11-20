import { isList, removeWhitespace } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const tupleLiteralMacro: ReaderMacro = {
  tag: "[",
  macro: (dream, _, reader) => {
    const items = removeWhitespace(reader(dream, "]"));
    if (isList(items)) return ["tuple", ...items];
    return ["tuple", items];
  },
};
