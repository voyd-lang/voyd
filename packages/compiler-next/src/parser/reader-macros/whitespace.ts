import { WhitespaceAtom } from "../ast/atom.js";
import { ReaderMacro } from "./types.js";

export const whitespaceReader: ReaderMacro = {
  match: (t) => t.isWhitespace,
  macro: (_file, { token }) => new WhitespaceAtom(token),
};
