import { ReaderMacro } from "./types.js";
import { prefixCall } from "./lib/init-helpers.js";

export const mapLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "#{",
  macro: (file, { reader }) => {
    const items = reader(file, "}");
    return prefixCall("map", ...items.toArray());
  },
};
