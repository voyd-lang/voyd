import { call, Expr, Form } from "./ast/index.js";
import { CharStream } from "./char-stream.js";
import { Lexer } from "./lexer.js";
import { getReaderMacroForToken } from "./reader-macros/index.js";
import { Token } from "./token.js";

export type ParseCharsOpts = {
  nested?: boolean;
  terminator?: string;
  lexer?: Lexer;
};

export const read = (file: CharStream, opts: ParseCharsOpts = {}): Form => {
  const lexer = opts.lexer ?? new Lexer();
  const location = file.currentSourceLocation();
  const elements: Expr[] = [];

  while (file.hasCharacters) {
    const token = lexer.tokenize(file);

    if (token.value === opts.terminator) {
      break;
    }

    const result = processWithReaderMacro(token, file, lexer, elements.at(-1));
    if (result) elements.push(result);
  }

  location.setEndToStartOf(file.currentSourceLocation());
  const form = new Form({ location, elements });
  return opts.nested ? form : call("ast", ...form.toArray());
};

/** Returns true if token was matched with and processed by a macro  */
const processWithReaderMacro = (
  token: Token,
  file: CharStream,
  lexer: Lexer,
  last?: Expr
) => {
  const readerMacro = getReaderMacroForToken(token, last, file.next);
  if (!readerMacro) return undefined;

  return readerMacro(file, {
    token,
    reader: (file, terminator) =>
      read(file, {
        nested: true,
        terminator,
        lexer,
      }),
  });
};
