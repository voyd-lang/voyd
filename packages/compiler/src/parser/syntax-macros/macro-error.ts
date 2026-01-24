import type { Syntax } from "../ast/index.js";

export class SyntaxMacroError extends Error {
  readonly syntax?: Syntax;

  constructor(message: string, syntax?: Syntax) {
    super(message);
    this.syntax = syntax;
  }
}

