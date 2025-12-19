import { ReaderMacro } from "./types.js";

export const parenReader: ReaderMacro = {
  match: (t) => t.value === "(",
  macro: (file, { reader }) => {
    const v = reader(file, ")");
    const split = v.split();
    if (split.length > 1) return split.insert("tuple");
    return split.insert("paren");
  },
};
