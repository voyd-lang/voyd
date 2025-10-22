import { ReaderMacro } from "./types.js";
import { call } from "./lib/init-helpers.js";

export const mapLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "#{",
  macro: (file, { reader }) => {
    const items = reader(file, "}");
    return call("map", ...items.toArray());
  },
};
