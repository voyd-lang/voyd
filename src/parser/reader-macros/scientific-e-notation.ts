import { Identifier, List, StringLiteral } from "../../syntax-objects/index.js";
import { ReaderMacro } from "./types.js";

export const scientificENotationMacro: ReaderMacro = {
  /** Regex from Michael Dumas https://regexlib.com/REDetails.aspx?regexp_id=2457 */
  match: (t) => /^[+-]?\d(\.\d+)?[Ee][+-]?\d+$/.test(t.value),
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
