import { Identifier, StringLiteral } from "../lib/syntax.mjs";
import { ReaderMacro } from "./types.mjs";

export const stringMacro: ReaderMacro = {
  tag: /^[\"\']$/,
  macro: (file, { token }) => {
    const startChar = token.value;
    token.value = "";
    while (file.hasCharacters) {
      const next = file.consume();

      if (next === "\\") {
        token.addChar(next);
        token.addChar(file.consume());
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
      });
    }

    return new StringLiteral({ value: token.value, location: token.location });
  },
};
