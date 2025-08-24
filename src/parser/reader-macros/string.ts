import { Identifier } from "../../syntax-objects/index.js";
import { makeString } from "../../syntax-objects/lib/make-string.js";
import { ReaderMacro } from "./types.js";

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
    token.location.endIndex = file.position;

    if (startChar === "'") {
      return new Identifier({
        value: token.value,
        location: token.location,
        isQuoted: true,
      });
    }

    return makeString(token.value, { location: token.location });
  },
};
