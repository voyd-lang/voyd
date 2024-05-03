import { noop } from "../syntax-objects/index.mjs";
import { ReaderMacro } from "./types.mjs";

export const comment: ReaderMacro = {
  tag: /^\/\/[^\s]*$/,
  macro: (file) => {
    while (file.hasCharacters) {
      if (file.next === "\n") break;
      file.consumeChar();
    }

    return noop();
  },
};
