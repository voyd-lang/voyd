import { Identifier, isList, List } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const tupleLiteralMacro: ReaderMacro = {
  tag: "[",
  macro: (file, { reader }) => {
    const tuple = new Identifier({ value: "tuple" });
    const items = reader(file, "]");
    if (isList(items)) return items.insert(tuple);
    return new List({ value: [tuple, items] });
  },
};
