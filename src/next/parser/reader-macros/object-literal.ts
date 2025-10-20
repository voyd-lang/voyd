import { CallForm } from "../ast/form.js";
import { ReaderMacro } from "./types.js";

export const objectLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "{",
  macro: (dream, { reader }) => {
    const items = reader(dream, "}");
    return new CallForm({
      location: items.location,
      elements: ["object", ...items.toArray()],
    });
  },
};
