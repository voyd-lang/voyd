import { ReaderMacro } from "./types.mjs";

export const genericsMacro: ReaderMacro = {
  match: (t, prev) => {
    return t.value === "<" && !!prev && /\w+/.test(prev.value);
  },
  macro: (file, { reader }) => {
    const items = reader(file, ">");
    return items.insert("generics").insert(",", 1);
  },
};
