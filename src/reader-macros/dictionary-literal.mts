import { Identifier, List } from "../syntax-objects/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const dictionaryLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "#{",
  macro: (file, { reader }) => {
    const dict = new Identifier({ value: "dict" });
    const items = reader(file, "}");
    if (items.isList()) return items.insert(dict);
    return new List({ value: [dict, items] });
  },
};
