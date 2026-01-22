import { CharStream } from "./char-stream.js";
import { read } from "./reader.js";
import {
  BASE_SYNTAX_MACROS,
  expandSyntaxMacros,
} from "./syntax-macros/index.js";

const parseWithSyntaxMacros = (
  text: string,
  filePath: string | undefined,
  syntaxMacros?: Parameters<typeof expandSyntaxMacros>[1]
) => {
  const chars = new CharStream(text, filePath ?? "raw");
  const rawAst = read(chars);
  return expandSyntaxMacros(rawAst, syntaxMacros);
};

export const parse = (text: string, filePath?: string) =>
  parseWithSyntaxMacros(text, filePath);

export const parseBase = (text: string, filePath?: string) =>
  parseWithSyntaxMacros(text, filePath, BASE_SYNTAX_MACROS);
