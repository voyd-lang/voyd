import { ReaderMacro } from "./types.js";

export const mapLiteralMacro: ReaderMacro = {
  match: (t) => t.value === "#{",
  macro: (file, { reader }) => {
    const items = reader(file, "}");
    return items.insert("map").insert(",", 1);
  },
};
