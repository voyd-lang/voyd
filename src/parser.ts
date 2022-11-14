import { getReaderMacroForToken } from "./reader-macros";

export type AST = Expr[];
export type Expr = string | AST;

export interface ParseOpts {
  nested?: boolean;
  terminator?: string;
}

export function parse(dream: string[], opts: ParseOpts = {}): AST {
  const ast: AST = [];

  while (dream.length) {
    const token = lexer(dream);

    const readerMacro = getReaderMacroForToken(token);

    if (readerMacro) {
      ast.push(
        readerMacro(dream, (dream, terminator) =>
          parse(dream, { nested: true, terminator })
        )
      );
      continue;
    }

    if (token === "(") {
      ast.push(parse(dream, { nested: true }));
      continue;
    }

    if (token === ")" || token === opts.terminator) {
      if (opts.nested) break;
      continue;
    }

    ast.push(token);
  }

  return ast;
}

const lexer = (dream: string[]): string => {
  let token = "";

  while (dream.length) {
    const char = dream[0];
    const isWhitespace = /\s/.test(char);

    if (isWhitespace && !token.length) {
      token += dream.shift()!;
      break;
    }

    if (isWhitespace) {
      break;
    }

    const isOpenBrace = /[\(\[\{]/.test(char);

    if (isOpenBrace && (token[0] === "#" || !token.length)) {
      token += dream.shift()!;
      break;
    }

    if (isOpenBrace) {
      break;
    }

    const isCloseBrace = /[\)\]\}]/.test(char);

    if (isCloseBrace && !token.length) {
      token += dream.shift()!;
      break;
    }

    if (isCloseBrace) {
      break;
    }

    token += dream.shift()!;
  }

  return token;
};
