import { Lexer } from "../lexer.js";
import { CharStream } from "../char-stream.js";
import { test } from "vitest";

const tokenize = (input: string) => {
  const chars = new CharStream(input, "test");
  const tokens: string[] = [];
  const lexer = new Lexer();
  while (chars.hasCharacters) {
    const token = lexer.tokenize(chars);
    if (!token.isWhitespace) {
      tokens.push(token.value);
    }
  }
  return tokens;
};

test("handles nested generics", ({ expect }) => {
  expect(tokenize("Map<List<int>>"))
    .toEqual(["Map", "<", "List", "<", "int", ">", ">"]);
});

test("tokenizes >> as operator outside generics", ({ expect }) => {
  expect(tokenize("a >> b")).toEqual(["a", ">>", "b"]);
});
