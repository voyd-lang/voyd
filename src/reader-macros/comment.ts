import { noop } from "../syntax-objects/index.mjs";
import { ReaderMacro } from "./types.mjs";

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
