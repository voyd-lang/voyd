import { Identifier, List, StringLiteral } from "../lib/syntax/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const scientificENotationMacro: ReaderMacro = {
  /** Regex from Michael Dumas https://regexlib.com/REDetails.aspx?regexp_id=2457 */
  tag: /^[+-]?\d(\.\d+)?[Ee][+-]?\d+$/,
  macro: (_, { token }) =>
    new List({ location: token.location })
      .push(new Identifier({ value: "scientific-e-notion" }))
      .push(
        new StringLiteral({
          value: token.value,
          location: token.location,
        })
      ),
};
