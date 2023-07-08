import { Identifier } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const objectLiteralMacro: ReaderMacro = {
  tag: "{",
  macro: (dream, { reader }) => {
    const struct = new Identifier({ value: "object" });
    const items = reader(dream, "}");
    return items.insert(struct);
  },
};
