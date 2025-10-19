import { Form } from "../ast/form.js";
import { isIdentifier } from "../grammar.js";
import { ReaderMacro } from "./types.js";

export const genericsMacro: ReaderMacro = {
  match: (t, prev) => {
    return t.value === "<" && !!isIdentifier(prev);
  },
  macro: (file, { reader }) => {
    const items = reader(file, ">");
    return new Form({
      location: items.location,
      elements: ["generics", ",", ...items.toArray()],
    });
  },
};
