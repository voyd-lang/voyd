import { ReaderMacro } from "./types.js";
import { Atom } from "../ast/atom.js";
import { Form } from "../ast/form.js";
import { SourceLocation } from "../ast/syntax.js";

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
      return token
        .toAtom()
        .setAttribute("isIdentifier", true)
        .setAttribute("isQuoted", true);
    }

    return makeString(token.value, token.location);
  },
};

export const makeString = (value: string, location?: SourceLocation) => {
  const codes = value
    .split("")
    .map((c) =>
      new Atom(String(c.charCodeAt(0)))
        .setAttribute("isInt", true)
        .setAttribute("intType", "i32")
    );

  return new Form({
    location,
    elements: [
      "new_string",
      ",",
      [
        "object",
        ",",
        "from",
        ":",
        ["FixedArray", ",", ["generics", ",", "i32"], ...codes],
      ],
    ],
  });
};
