import { Form } from "../ast/form.js";
import { ReaderMacro } from "./types.js";

export const objectLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "{",
  macro: (dream, { reader }) => {
    const items = reader(dream, "}");
    return new Form({
      location: items.location,
      elements: ["object", ",", ...items.toArray()],
    });
  },
};
