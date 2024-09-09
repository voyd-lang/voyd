import { List } from "../../../syntax-objects/list.js";
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
    const html = parser.parse(start.value);
    return new List({ value: ["html", html], location: token.location });
  },
};
