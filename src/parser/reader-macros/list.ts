import { ReaderMacro } from "./types.js";

export const listReader: ReaderMacro = {
  match: (t) => t.value === "(" || t.value === ")",
  macro: (file, { token, reader }) => {
    if (token.value === "(") {
      const list = reader(file, ")");
      list.setAttribute("tuple?", true);
      return list;
    }

    return undefined; // discard closing paren
  },
};
