import { Form } from "../ast/form.js";
import { ReaderMacro } from "./types.js";

const SCI = /^[+-]?\d(\.\d+)?[Ee][+-]?\d+$/;

export const scientificENotationMacro: ReaderMacro = {
  /** Regex from Michael Dumas https://regexlib.com/REDetails.aspx?regexp_id=2457 */
  match: (t) => SCI.test(t.value),
  macro: (_, { token }) =>
    new Form({
      location: token.location,
      elements: [
        "scientific-e-notion",
        token
          .toAtom()
          .setAttribute("isIdentifier", true)
          .setAttribute("isQuoted", true),
      ],
    }),
};
