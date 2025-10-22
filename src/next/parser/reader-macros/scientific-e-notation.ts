import { IdentifierAtom } from "../ast/atom.js";
import { ReaderMacro } from "./types.js";
import { call } from "./lib/init-helpers.js";

const SCI = /^[+-]?\d(\.\d+)?[Ee][+-]?\d+$/;

export const scientificENotationMacro: ReaderMacro = {
  /** Regex from Michael Dumas https://regexlib.com/REDetails.aspx?regexp_id=2457 */
  match: (t) => SCI.test(t.value),
  macro: (_, { token }) =>
    call("scientific-e-notion", new IdentifierAtom(token).setIsQuoted(true)),
};
