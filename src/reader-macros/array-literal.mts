import { removeWhitespace } from "../lib";
import { ReaderMacro } from "./types";

export const arrayLiteralMacro: ReaderMacro = {
  tag: "#[",
  macro: (dream, _, reader) => [
    "array",
    ...removeWhitespace(reader(dream, "]")),
  ],
};
