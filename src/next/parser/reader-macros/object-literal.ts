import { ReaderMacro } from "./types.js";

export const objectLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "{",
  macro: (dream, { reader }) => {
    const items = reader(dream, "}");
    return items.splitInto("object_literal");
  },
};
