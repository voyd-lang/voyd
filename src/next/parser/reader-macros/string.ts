import { ReaderMacro } from "./types.js";
import { identifier, string } from "../ast/lib.js";

export const stringMacro: ReaderMacro = {
  match: (t) => t.value === '"' || t.value === "'",
  macro: (file, { token }) => {
    const startChar = token.value;
    token.value = "";
    while (file.hasCharacters) {
      const next = file.consumeChar();

      if (next === "\\") {
        token.addChar(next);
        token.addChar(file.consumeChar());
        continue;
      }

      if (next === startChar) {
        break;
      }

      token.addChar(next);
    }
    token.setEndLocationToStartOf(file.currentSourceLocation());

    if (startChar === "'") {
      return identifier(token.value)
        .setLocation(token.location)
        .setIsQuoted(true);
    }

    return string(token.value).setLocation(token.location);
  },
};
