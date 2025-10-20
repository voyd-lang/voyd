import { ArrayLiteralForm } from "../ast/form.js";
import { ReaderMacro } from "./types.js";

export const arrayLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "[",
  macro: (file, { reader }) => {
    const items = reader(file, "]");
    return new ArrayLiteralForm({
      location: items.location,
      elements: items.toArray(),
    });
  },
};
