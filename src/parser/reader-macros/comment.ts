import { noop } from "../../syntax-objects/index.js";
import { ReaderMacro } from "./types.js";

export const comment: ReaderMacro = {
  match: (t) => /^\/\/[^\s]*$/.test(t.value),
  macro: (file) => {
    while (file.hasCharacters) {
      if (file.next === "\n") break;
      file.consumeChar();
    }

    return noop();
  },
};
