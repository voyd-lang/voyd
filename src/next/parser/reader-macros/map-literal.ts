import { Form } from "../ast/form.js";
import { ReaderMacro } from "./types.js";

export const mapLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "#{",
  macro: (file, { reader }) => {
    const items = reader(file, "}");
    return new Form({
      location: items.location,
      elements: ["map", ",", ...items.toArray()],
    });
  },
};
