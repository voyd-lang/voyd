import { ParenForm } from "../ast/form.js";
import { ReaderMacro } from "./types.js";

export const parenReader: ReaderMacro = {
  match: (t) => t.value === "(" || t.value === ")",
  macro: (file, { token, reader }) => {
    if (token.value === "(") {
      const v = reader(file, ")");
      return new ParenForm({ location: v.location, elements: v.toArray() });
    }

    return undefined; // discard closing paren
  },
};
