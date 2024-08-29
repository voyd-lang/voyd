import { Expr } from "./expr.mjs";
import { LexicalContext } from "./lexical-context.mjs";
import { Syntax, SyntaxMetadata } from "./syntax.mjs";

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
      lexicon: this.lexicon,
    };
  }
}
