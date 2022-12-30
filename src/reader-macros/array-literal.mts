import { Identifier, isList, List } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const arrayLiteralMacro: ReaderMacro = {
  tag: "#[",
  macro: (file, { reader }) => {
    const array = new Identifier({ value: "array" });
    const items = reader(file, "]");
    if (isList(items)) return items.insert(array);
    return new List({ value: [array, items] });
  },
};
