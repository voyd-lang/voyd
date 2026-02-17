import { ReaderMacro } from "./types.js";

export const comment: ReaderMacro = {
  match: (t) => t.value.startsWith("//"),
  macro: (file, { token }) => {
    while (file.hasCharacters) {
      if (file.next === "\n") break;
      token.addChar(file.consumeChar());
    }

    token.setEndLocationToStartOf(file.currentSourceLocation());
    return undefined;
  },
};
