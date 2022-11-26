import { isList, removeWhitespace } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const structLiteralMacro: ReaderMacro = {
  tag: "{",
  macro: (dream, _, reader) => {
    const items = removeWhitespace(reader(dream, "}"));
    if (isList(items)) return ["struct", ...items];
    return ["struct", items];
  },
};
