import { Expr, Form } from "./ast/index.js";
import { CharStream } from "./char-stream.js";
import { Lexer } from "./lexer.js";
import { getReaderMacroForToken } from "./reader-macros/index.js";
import { Token } from "./token.js";

export type ParseCharsOpts = {
  nested?: boolean;
  terminator?: string;
};

export const parseChars = (
  file: CharStream,
  opts: ParseCharsOpts = {}
): Expr => {
  const lexer = new Lexer();
  const form = new Form({ location: file.currentSourceLocation() });

  while (file.hasCharacters) {
    const token = lexer.tokenize(file);

    if (token.value === opts.terminator) {
      break;
    }

    if (processWithReaderMacro(token, file, form)) {
      continue;
    }
  }

  form?.setEndLocationToStartOf(file.currentSourceLocation());
  return opts.nested ? form : new Form(["ast", form]);
};

/** Returns true if token was matched with and processed by a macro  */
const processWithReaderMacro = (token: Token, file: CharStream, form: Form) => {
  const readerMacro = getReaderMacroForToken(token, form.last, file.next);
  if (!readerMacro) return undefined;

  const result = readerMacro(file, {
    token,
    reader: (file, terminator) =>
      parseChars(file, {
        nested: true,
        terminator,
      }),
  });

  if (result) form.push(result);
  return true;
};
