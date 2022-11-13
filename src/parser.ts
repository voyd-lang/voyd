export type AST = Expr[];
export type Expr = string | AST;

export interface ParseOpts {
  nested?: boolean;
  insertToken?: string;
}

export function parse(dream: string[], opts: ParseOpts = {}): AST {
  const ast: AST = [];
  let token = "";

  const pushCurrentToken = () => {
    if (token) ast.push(token);
    token = "";
  };

  if (opts.insertToken) {
    ast.push(opts.insertToken);
  }

  while (dream.length) {
    const char = dream.shift();

    if (char === "(" && token) {
      ast.push(parse(dream, { insertToken: token, nested: true }));
      token = "";
      continue;
    }

    if (char === "(") {
      ast.push(parse(dream, { nested: true }));
      continue;
    }

    if (char === ")") {
      pushCurrentToken();
      if (opts.nested) break;
      continue;
    }

    if (char === " " || char === "\t" || char === "\n") {
      pushCurrentToken();
      ast.push(char);
      continue;
    }

    token += char;
  }

  return ast;
}
