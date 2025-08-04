import { Expr } from "../syntax-objects/expr.js";
import { List } from "../syntax-objects/list.js";
import { CharStream } from "./char-stream.js";
import { lexer } from "./lexer.js";
import { getReaderMacroForToken } from "./reader-macros/index.js";
import { Token } from "./token.js";

export type ParseCharsOpts = {
  nested?: boolean;
  terminator?: string;
  parent?: Expr;
};

export const parseChars = (
  file: CharStream,
  opts: ParseCharsOpts = {}
): List => {
  const list = new List({
    location: file.currentSourceLocation(),
    parent: opts.parent,
  });

  while (file.hasCharacters) {
    const token = lexer(file);

    if (token.value === opts.terminator) {
      break;
    }

    if (processWithReaderMacro(token, list.last(), file, list)) {
      continue;
    }
  }

  list.location!.endIndex = file.position;
  list.location!.endColumn = file.column;
  return opts.nested ? list : new List(["ast", list]);
};

/** Returns true if token was matched with and processed by a macro  */
const processWithReaderMacro = (
  token: Token,
  prev: Expr | undefined,
  file: CharStream,
  list: List
) => {
  const readerMacro = getReaderMacroForToken(token, prev, file.next);
  if (!readerMacro) return undefined;

  const result = readerMacro(file, {
    token,
    reader: (file, terminator) =>
      parseChars(file, {
        nested: true,
        terminator,
      }),
  });

  if (result) list.push(result);
  return true;
};
