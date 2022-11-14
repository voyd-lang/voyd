import { readerMacros } from "./reader-macros";

export type AST = Expr[];
export type Expr = string | AST;

export interface ParseOpts {
  nested?: boolean;
  insertToken?: string;
  terminator?: string;
}

export function parse(dream: string[], opts: ParseOpts = {}): AST {
  const ast: AST = [];
  let token = "";

  const runReaderMacro = (tag: string) => {
    ast.push(
      readerMacros.get(tag)!(dream, (dream, terminator) =>
        parse(dream, { nested: true, terminator })
      )
    );
  };

  const pushCurrentToken = () => {
    if (token[0] === "#" && readerMacros.has(token)) {
      runReaderMacro(token);
      token = "";
      return;
    }

    if (token) ast.push(token);
    token = "";
  };

  if (opts.insertToken) {
    ast.push(opts.insertToken);
  }

  while (dream.length) {
    const char = dream.shift();

    if (char === " " || char === "\t" || char === "\n") {
      pushCurrentToken();
      ast.push(char);
      continue;
    }

    if (token[0] === "#") {
      token += char;
      if (["(", "[", "{"].includes(char!)) pushCurrentToken();
      continue;
    }

    if (readerMacros.has(char ?? "")) {
      pushCurrentToken();
      runReaderMacro(char!);
      continue;
    }

    if (char === "(" && token) {
      ast.push(parse(dream, { insertToken: token, nested: true }));
      token = "";
      continue;
    }

    if (char === "(") {
      ast.push(parse(dream, { nested: true }));
      continue;
    }

    if (char === ")" || char === opts.terminator || token === opts.terminator) {
      pushCurrentToken();
      if (opts.nested) break;
      continue;
    }

    token += char;
  }

  return ast;
}
