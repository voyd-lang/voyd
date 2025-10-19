import { Form } from "../ast/form.js";
import { ReaderMacro } from "./types.js";

export const arrayLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "[",
  macro: (file, { reader }) => {
    const items = reader(file, "]");
    const result = new Form({
      location: items.location,
      elements: ["array", "1", ...items.toArray()],
    });
    result.setAttribute("isArrayLiteral", true);
    return result;
  },
};
