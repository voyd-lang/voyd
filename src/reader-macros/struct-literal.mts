import { removeWhitespace } from "../lib/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const structLiteralMacro: ReaderMacro = {
  tag: "{",
  macro: (dream, _, reader) => [
    "struct",
    ...removeWhitespace(reader(dream, "}")),
  ],
};
