import { isList } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const structLiteralMacro: ReaderMacro = {
  tag: "{",
  macro: (dream, _, reader) => {
    const items = reader(dream, "}");
    if (isList(items)) return ["struct", ...items];
    return ["struct", items];
  },
};
