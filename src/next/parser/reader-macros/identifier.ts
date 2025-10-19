import { ReaderMacro } from "./types.js";

export const identifierReader: ReaderMacro = {
  match: (t) => !!t.value,
  macro: (_file, { token }) =>
    token.toAtom().setAttribute("isIdentifier", true),
};
