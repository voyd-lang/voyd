import { ReaderMacro } from "./types.js";

export const dictionaryLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "#{",
  macro: (file, { reader }) => {
    const items = reader(file, "}");
    return items.insert("dict");
  },
};
