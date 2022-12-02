import { isList } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const tupleLiteralMacro: ReaderMacro = {
  tag: "[",
  macro: (dream, { reader }) => {
    const items = reader(dream, "]");
    if (isList(items)) return ["tuple", ",", ...items];
    return ["tuple", items];
  },
};
