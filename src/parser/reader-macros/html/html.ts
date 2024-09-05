import { Identifier } from "../../../syntax-objects/identifier.js";
import { lexer } from "../../lexer.js";
import { ReaderMacro } from "../types.js";
import { HTMLParser } from "./html-parser.js";

export const htmlMacro: ReaderMacro = {
  match: (t, prev, nextChar) => {
    return (
      t.value === "<" &&
      !!prev?.isWhitespace() &&
      !!nextChar &&
      /\w/.test(nextChar)
    );
  },
  macro: (file, { token, reader }) => {
    const parser = new HTMLParser(file, {
      onUnescapedCurlyBrace: () => {
        file.consumeChar();
        return reader(file, "}");
      },
    });
    const start = lexer(file);
    const json = parser.parse(start.value);

    const id = new Identifier({ value: "html", location: token.location });
    id.json = json;
    return id;
  },
};
