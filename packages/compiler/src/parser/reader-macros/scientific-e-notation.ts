import { Identifier, List } from "../../syntax-objects/index.js";
import { ReaderMacro } from "./types.js";

const SCI = /^[+-]?\d(\.\d+)?[Ee][+-]?\d+$/;

export const scientificENotationMacro: ReaderMacro = {
  /** Regex from Michael Dumas https://regexlib.com/REDetails.aspx?regexp_id=2457 */
  match: (t) => SCI.test(t.value),
  macro: (_, { token }) =>
    new List({ location: token.location })
      .push(new Identifier({ value: "scientific-e-notion" }))
      .push(
        new Identifier({
          value: token.value,
          location: token.location,
          isQuoted: true,
        })
      ),
};
