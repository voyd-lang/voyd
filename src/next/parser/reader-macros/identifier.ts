import { IdentifierAtom } from "../ast/atom.js";
import { ReaderMacro } from "./types.js";

export const identifierReader: ReaderMacro = {
  match: (t) => !!t.value,
  macro: (_file, { token }) => new IdentifierAtom(token),
};
