import { ReaderMacro } from "./types.mjs";

export const scientificENotationMacro: ReaderMacro = {
  /** Regex from Michael Dumas https://regexlib.com/REDetails.aspx?regexp_id=2457 */
  tag: /^[+-]?\d(\.\d+)?[Ee][+-]?\d+$/,
  macro: (_, token) => ["scientific-e-notation", token],
};
