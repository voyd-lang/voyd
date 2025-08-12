import { lexer, resetLexerState } from "../lexer.js";
import { CharStream } from "../char-stream.js";
import { test } from "vitest";

const tokenize = (input: string) => {
  const chars = new CharStream(input, "test");
  const tokens: string[] = [];
  while (chars.hasCharacters) {
    const token = lexer(chars);
    if (!token.isWhitespace) {
      tokens.push(token.value);
    }
  }
  resetLexerState();
  return tokens;
};

test("handles nested generics", ({ expect }) => {
  expect(tokenize("Map<List<int>>"))
    .toEqual(["Map", "<", "List", "<", "int", ">", ">"]);
});

test("tokenizes >> as operator outside generics", ({ expect }) => {
  expect(tokenize("a >> b")).toEqual(["a", ">>", "b"]);
});
