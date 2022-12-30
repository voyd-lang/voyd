import { newIdentifier, newList, newToken } from "../lib/syntax-helpers.mjs";
import { Identifier, StringLiteral } from "../lib/syntax.mjs";
import { ReaderMacro } from "./types.mjs";

export const scientificENotationMacro: ReaderMacro = {
  /** Regex from Michael Dumas https://regexlib.com/REDetails.aspx?regexp_id=2457 */
  tag: /^[+-]?\d(\.\d+)?[Ee][+-]?\d+$/,
  macro: (file, { token }) =>
    newList(file)
      .push(new Identifier({ value: "scientific-e-notion" }))
      .push(
        new StringLiteral({
          value: token.value,
          location: token.location,
        })
      ),
};
