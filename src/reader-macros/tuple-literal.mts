import { removeWhitespace } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const tupleLiteralMacro: ReaderMacro = {
  tag: "[",
  macro: (dream, _, reader) => [
    "tuple",
    ...removeWhitespace(reader(dream, "]")),
  ],
};
