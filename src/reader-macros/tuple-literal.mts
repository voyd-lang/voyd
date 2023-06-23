import { Identifier, List } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const tupleLiteralMacro: ReaderMacro = {
  tag: "[",
  macro: (file, { reader }) => {
    const tuple = new Identifier({ value: "tuple" });
    const items = reader(file, "]");
    if (items.isList()) return items.insert(tuple);
    return new List({ value: [tuple, items] });
  },
};
