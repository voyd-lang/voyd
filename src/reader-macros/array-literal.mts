import { removeWhitespace } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const arrayLiteralMacro: ReaderMacro = {
  tag: "#[",
  macro: (dream, _, reader) => [
    "array",
    ...removeWhitespace(reader(dream, "]")),
  ],
};
