import { ReaderMacro } from "./types.js";

export const whitespaceReader: ReaderMacro = {
  match: (t) => t.isWhitespace,
  macro: (_file, { token }) =>
    token.toAtom().setAttribute("isWhitespace", true),
};
