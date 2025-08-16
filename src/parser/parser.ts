import { List } from "../syntax-objects/index.js";
import { CharStream } from "./char-stream.js";
import { parseChars } from "./parse-chars.js";
import { ReaderMacro } from "./reader-macros/types.js";
import { expandSyntaxMacros } from "./syntax-macros/index.js";

export const parse = (
  text: string,
  filePath?: string,
  macros?: ReaderMacro[]
): List => {
  const chars = new CharStream(text, filePath ?? "raw");
  const rawAst = parseChars(chars, { macros });
  return expandSyntaxMacros(rawAst);
};
