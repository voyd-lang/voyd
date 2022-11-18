import { removeWhitespace } from "../lib";
import { ReaderMacro } from "./types";

export const structLiteralMacro: ReaderMacro = {
  tag: "{",
  macro: (dream, _, reader) => [
    "struct",
    ...removeWhitespace(reader(dream, "}")),
  ],
};
