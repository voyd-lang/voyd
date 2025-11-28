import { Whitespace } from "../../syntax-objects/whitespace.js";
import { ReaderMacro } from "./types.js";

export const whitespaceReader: ReaderMacro = {
  match: (t) => t.isWhitespace,
  macro: (_file, { token }) => {
    return new Whitespace({ value: token.value, location: token.location });
  },
};
