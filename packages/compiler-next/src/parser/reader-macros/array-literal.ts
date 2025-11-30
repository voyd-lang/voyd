import { label, surfaceCall } from "../ast/init-helpers.js";
import { ReaderMacro } from "./types.js";

export const arrayLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "[",
  macro: (file, { reader }) => {
    const items = reader(file, "]");
    return surfaceCall(
      "new_array",
      label("from", items.splitInto("fixed_array_literal"))
    );
  },
};
