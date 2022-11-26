import { isList } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const arrayLiteralMacro: ReaderMacro = {
  tag: "#[",
  macro: (dream, _, reader) => {
    const items = reader(dream, "]");
    if (isList(items)) return ["array", ...items];
    return ["array", items];
  },
};
