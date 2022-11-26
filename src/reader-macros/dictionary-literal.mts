import { isList } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const dictionaryLiteralMacro: ReaderMacro = {
  tag: "#{",
  macro: (dream, _, reader) => {
    const items = reader(dream, "}");
    if (isList(items)) return ["dictionary", ...items];
    return ["dictionary", items];
  },
};
