import { Identifier } from "../../syntax-objects/identifier.js";
import { ReaderMacro } from "./types.js";

export const identifierReader: ReaderMacro = {
  match: (t) => !!t.value,
  macro: (_file, { token }) => {
    return new Identifier({
      value: token.value.trim(),
      location: token.location,
    });
  },
};
