import { CharStream } from "../char-stream.js";
import { HTMLParser } from "../reader-macros/html/html-parser.js";
import { test } from "vitest";

const parseHtml = (code: string): any => {
  const stream = new CharStream(code, "test.vd");
  const parser = new HTMLParser(stream, { onUnescapedCurlyBrace: () => undefined });
  return JSON.parse(JSON.stringify(parser.parse().toJSON()));
};

test("preserves whitespace in text nodes", (t) => {
  const ast = parseHtml("<div>Hello <span>world</span></div>");
  const children = ast[2][1][3][2];
  const firstText = children[2];
  const codes = firstText[1][2][0][1].slice(1);
  t.expect(String.fromCharCode(...codes)).toBe("Hello ");
});
