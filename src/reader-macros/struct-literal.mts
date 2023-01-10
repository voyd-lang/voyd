import { Identifier, isList, List } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const structLiteralMacro: ReaderMacro = {
  tag: "{",
  macro: (dream, { reader }) => {
    const struct = new Identifier({ value: "struct" });
    const items = reader(dream, "}");
    return items.insert(struct);
  },
};
