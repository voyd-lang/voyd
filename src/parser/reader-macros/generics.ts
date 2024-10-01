import { ReaderMacro } from "./types.js";

export const genericsMacro: ReaderMacro = {
  match: (t, prev) => {
    return t.value === "<" && !!prev?.isIdentifier();
  },
  macro: (file, { reader }) => {
    const items = reader(file, ">");
    return items.insert("generics").insert(",", 1);
  },
};
