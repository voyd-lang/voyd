import { Expr } from "./expr.js";
import { LexicalContext } from "./lib/lexical-context.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export type ScopedEntity = Expr & {
  lexicon: LexicalContext;
};

export type ScopedSyntaxMetadata = SyntaxMetadata & {
  lexicon?: LexicalContext;
};

export abstract class ScopedSyntax extends Syntax {
  readonly lexicon: LexicalContext;

  constructor(opts: ScopedSyntaxMetadata) {
    super(opts);
    this.lexicon = opts.lexicon ?? new LexicalContext();
  }

  getCloneOpts(parent?: Expr | undefined): ScopedSyntaxMetadata {
    return {
      ...super.getCloneOpts(parent),
    };
  }
}
