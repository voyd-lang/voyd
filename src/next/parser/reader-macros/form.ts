import { ReaderMacro } from "./types.js";

export const formReader: ReaderMacro = {
  match: (t) => t.value === "(" || t.value === ")",
  macro: (file, { token, reader }) => {
    if (token.value === "(") {
      return reader(file, ")").setAttribute("mightBeTuple", true);
    }

    return undefined; // discard closing paren
  },
};
