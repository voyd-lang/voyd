import { ModuleInfo } from "./lib/module-info.mjs";
import { getReaderMacroForToken } from "./reader-macros/index.mjs";

export type AST = Expr[];
export type Expr = string | number | boolean | AST;

export interface ParseOpts {
  nested?: boolean;
  terminator?: string;
  module: ModuleInfo;
}

export function parse(dream: string[], opts: ParseOpts): AST {
  const ast: AST = [];

  while (dream.length) {
    const token = lexer(dream);

    const readerMacro = getReaderMacroForToken(token);

    if (readerMacro) {
      const result = readerMacro(dream, {
        token,
        module: opts.module,
        reader: (dream, terminator) =>
          parse(dream, { nested: true, terminator, module: opts.module }),
      });
      if (typeof result !== "undefined") ast.push(result);
      continue;
    }

    if (token === "(") {
      ast.push(parse(dream, { nested: true, module: opts.module }));
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

    // Handle real numbers
    if (char === "." && /^[0-9]+$/.test(token)) {
      token += dream.shift();
      continue;
    }

    const isTerminator = /[\{\[\(\}\]\)\s\.\;\:\'\"\,]/.test(char);

    if (isTerminator && (token[0] === "#" || !token.length)) {
      token += dream.shift()!;
      break;
    }

    if (isTerminator) {
      break;
    }

    token += dream.shift()!;
  }

  return token;
};
