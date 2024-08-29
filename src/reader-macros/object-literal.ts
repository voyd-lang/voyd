import { ReaderMacro } from "./types.mjs";

export const objectLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "{",
  macro: (dream, { reader }) => {
    const items = reader(dream, "}");
    return items.insert("object").insert(",", 1);
  },
};
