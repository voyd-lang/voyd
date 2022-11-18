import { removeWhitespace } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const dictionaryLiteralMacro: ReaderMacro = {
  tag: "#{",
  macro: (dream, _, reader) => [
    "dictionary",
    ...removeWhitespace(reader(dream, "}")),
  ],
};
