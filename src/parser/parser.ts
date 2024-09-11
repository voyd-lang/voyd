import { List } from "../syntax-objects/index.js";
import { CharStream } from "./char-stream.js";
import { parseChars } from "./parse-chars.js";
import { expandSyntaxMacros } from "./syntax-macros/index.js";

export const parse = (text: string, filePath?: string): List => {
  const chars = new CharStream(text, filePath ?? "raw");
  const rawAst = parseChars(chars);
  return expandSyntaxMacros(rawAst);
};
