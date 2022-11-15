import { removeWhitespace } from "../lib";
import { ReaderMacro } from "./types";

export const dictionaryLiteralMacro: ReaderMacro = {
  tag: "#{",
  macro: (dream, _, reader) => [
    "dictionary",
    ...removeWhitespace(reader(dream, "}")),
  ],
};
