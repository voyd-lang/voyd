import { Identifier, isList, List } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const structLiteralMacro: ReaderMacro = {
  tag: "{",
  macro: (dream, { reader }) => {
    const struct = new Identifier({ value: "dict" });
    const items = reader(dream, "}");
    if (isList(items)) return items.insert(struct);
    return new List({ value: [struct, items] });
  },
};
