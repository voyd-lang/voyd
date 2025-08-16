import { Expr } from "../syntax-objects/expr.js";
import { List } from "../syntax-objects/list.js";
import { CharStream } from "./char-stream.js";
import { Lexer } from "./lexer.js";
import { getReaderMacroForToken } from "./reader-macros/index.js";
import { ReaderMacro } from "./reader-macros/types.js";
import { Token } from "./token.js";

export type ParseCharsOpts = {
  nested?: boolean;
  terminator?: string;
  parent?: Expr;
  lexer?: Lexer;
  macros?: ReaderMacro[];
};

export const parseChars = (
  file: CharStream,
  opts: ParseCharsOpts = {}
): List => {
  const lexer = opts.lexer ?? new Lexer();
  const { macros } = opts;
  const list = new List({
    location: file.currentSourceLocation(),
    parent: opts.parent,
  });

  while (file.hasCharacters) {
    const token = lexer.tokenize(file);

    if (token.value === opts.terminator) {
      break;
    }

    if (processWithReaderMacro(token, list.last(), file, list, lexer, macros)) {
      continue;
    }
  }

  list?.setEndLocationToStartOf(file.currentSourceLocation());
  return opts.nested ? list : new List(["ast", list]);
};

/** Returns true if token was matched with and processed by a macro  */
const processWithReaderMacro = (
  token: Token,
  prev: Expr | undefined,
  file: CharStream,
  list: List,
  lexer: Lexer,
  macros?: ReaderMacro[]
) => {
  const readerMacro = getReaderMacroForToken(token, prev, file.next, macros);
  if (!readerMacro) return undefined;

  const result = readerMacro(file, {
    token,
    reader: (file, terminator) =>
      parseChars(file, {
        nested: true,
        terminator,
        lexer,
        macros,
      }),
  });

  if (result) list.push(result);
  return true;
};
