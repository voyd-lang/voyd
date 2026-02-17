import { isWhitespaceAtom } from "../../ast/predicates.js";
import { Lexer } from "../../lexer.js";
import { ReaderMacro } from "../types.js";
import { HTMLParser } from "./html-parser.js";

// Only trigger HTML parsing when a tag starts with a letter.
// This avoids matching numeric comparisons like "< 32" or generics.
const TAG_START = /[A-Za-z]/;

export const htmlMacro: ReaderMacro = {
  match: (t, prev, nextChar) => {
    return (
      t.value === "<" &&
      !!isWhitespaceAtom(prev) &&
      !!nextChar &&
      TAG_START.test(nextChar)
    );
  },
  macro: (file, { reader }) => {
    const parser = new HTMLParser(file, {
      onUnescapedCurlyBrace: () => {
        file.consumeChar();
        const list = reader(file, "}");
        if (list.length === 0) {
          return undefined;
        }
        return list;
      },
    });
    const start = new Lexer().tokenize(file);
    const html = parser.parse(start.value);
    return html;
  },
};
