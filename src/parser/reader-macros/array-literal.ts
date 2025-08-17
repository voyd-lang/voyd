import { ReaderMacro } from "./types.js";

export const arrayLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "[",
  macro: (file, { reader }) => {
    const items = reader(file, "]");
    const result = items.insert("array").insert(",", 1);
    result.setAttribute("array-literal", true);
    return result;
  },
};
