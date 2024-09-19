import { ReaderMacro } from "./types.js";

export const arrayLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "[",
  macro: (file, { reader }) => {
    const items = reader(file, "]");
    return items.insert("array").insert(",", 1);
  },
};
