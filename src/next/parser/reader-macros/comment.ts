import { ReaderMacro } from "./types.js";

export const comment: ReaderMacro = {
  match: (t) => t.value === "//",
  macro: (file, { token }) => {
    while (file.hasCharacters) {
      if (file.next === "\n") break;
      token.addChar(file.consumeChar());
    }

    token.setEndLocationToStartOf(file.currentSourceLocation());
    return token.toAtom().setAttribute("isComment", true);
  },
};
