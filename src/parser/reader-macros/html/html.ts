import { List } from "../../../syntax-objects/list.js";
import { Lexer } from "../../lexer.js";
import { ReaderMacro } from "../types.js";
import { HTMLParser } from "./html-parser.js";

const W = /\w/;

export const htmlMacro: ReaderMacro = {
  match: (t, prev, nextChar) => {
    return (
      t.value === "<" &&
      !!prev?.isWhitespace() &&
      !!nextChar &&
      W.test(nextChar)
    );
  },
  macro: (file, { token, reader }) => {
    const parser = new HTMLParser(file, {
      onUnescapedCurlyBrace: () => {
        file.consumeChar();
        return reader(file, "}");
      },
    });
    const start = new Lexer().tokenize(file);
    const html = parser.parse(start.value);
    return html;
  },
};
