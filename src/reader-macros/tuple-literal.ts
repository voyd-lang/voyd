import { removeWhitespace } from "../lib";
import { ReaderMacro } from "./types";

export const tupleLiteralMacro: ReaderMacro = {
  tag: "[",
  macro: (dream, _, reader) => [
    "tuple",
    ...removeWhitespace(reader(dream, "]")),
  ],
};
