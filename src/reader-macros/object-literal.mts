import { ReaderMacro } from "./types.mjs";

export const objectLiteralMacro: ReaderMacro = {
  tag: "{",
  macro: (dream, { reader }) => {
    const items = reader(dream, "}");
    return items.insert("object").insert(",", 1);
  },
};
