import { Expr } from "./ast/expr.js";
import { CharStream } from "./char-stream.js";
import { parseChars } from "./parse-chars.js";
import { expandSyntaxMacros } from "./syntax-macros/index.js";

export const parse = (text: string, filePath?: string): Expr => {
  const chars = new CharStream(text, filePath ?? "raw");
  const rawAst = parseChars(chars);
  return expandSyntaxMacros(rawAst);
};
