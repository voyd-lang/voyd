import { Expr } from "../ast/expr.js";
import { Form } from "../ast/form.js";
import { CharStream } from "../char-stream.js";
import { Token } from "../token.js";

export interface ReaderMacro {
  match: (token: Token, prev?: Expr, nextChar?: string) => boolean;
  macro: (
    file: CharStream,
    opts: {
      token: Token;
      reader: (file: CharStream, terminator?: string) => Form;
    }
  ) => Expr | undefined;
}
