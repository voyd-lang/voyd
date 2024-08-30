import { Expr } from "../syntax-objects/expr.js";
import { Identifier } from "../syntax-objects/identifier.js";
import { List } from "../syntax-objects/list.js";
import { Whitespace } from "../syntax-objects/whitespace.js";
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
    value: !opts.nested ? ["ast", ","] : [],
  });

  let prev: Token | undefined = undefined;
  let cur: Token | undefined = undefined;
  while (file.hasCharacters) {
    const token = lexer(file);
    prev = cur;
    cur = token;

    if (processWithReaderMacro(token, prev, file, opts, list)) {
      continue;
    }

    if (token.is("(")) {
      const subList = parseChars(file, { nested: true });
      subList.mayBeTuple = true;
      list.push(subList);
      continue;
    }

    if (token.is(")") || token.is(opts.terminator)) {
      if (opts.nested) break;
      continue;
    }

    if (token.isWhitespace) {
      list.push(
        new Whitespace({
          value: token.value,
          location: token.location,
        })
      );
      continue;
    }

    list.push(
      new Identifier({
        value: token.value,
        location: token.location,
      })
    );
  }

  list.location!.endIndex = file.position;
  return list;
};

/** Returns true if token was matched with and processed by a macro  */
const processWithReaderMacro = (
  token: Token,
  prev: Token | undefined,
  file: CharStream,
  opts: ParseCharsOpts,
  list: List
) => {
  const readerMacro = getReaderMacroForToken(token, prev);
  if (!readerMacro) return undefined;

  const result = readerMacro(file, {
    token,
    reader: (file, terminator, parent) =>
      parseChars(file, {
        nested: true,
        terminator,
        parent: parent ?? opts.parent,
      }),
  });

  if (!result) return undefined;

  list.push(result);
  return true;
};
