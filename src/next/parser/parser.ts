import { CharStream } from "./char-stream.js";
import { read } from "./reader.js";
import { expandSyntaxMacros } from "./syntax-macros/index.js";

export const parse = (text: string, filePath?: string) => {
  const chars = new CharStream(text, filePath ?? "raw");
  const rawAst = read(chars);
  return expandSyntaxMacros(rawAst);
};
