import { Expr } from "./expr.mjs";
import { Id, Identifier } from "./identifier.mjs";
import { LexicalContext } from "./lexical-context.mjs";
import { Syntax, SyntaxMetadata } from "./syntax.mjs";

export type NamedEntityOpts = SyntaxMetadata & {
  name: Id;
  id?: string;
  isExported?: boolean;
};

export abstract class NamedEntity extends Syntax {
  readonly id: string;
  readonly name: Identifier;
  isExported = false;

  constructor(opts: NamedEntityOpts) {
    super(opts);
    this.name =
      typeof opts.name === "string" ? Identifier.from(opts.name) : opts.name;
    this.id = opts.id ?? this.genId();
    this.isExported = opts.isExported ?? false;
  }

  private genId() {
    return `${this.name}#${this.syntaxId}`;
  }

  getCloneOpts(parent?: Expr): NamedEntityOpts {
    return {
      ...super.getCloneOpts(parent),
      id: this.id,
      name: this.name,
      isExported: this.isExported,
    };
  }
}

export type ScopedNamedEntityOpts = NamedEntityOpts & {
  lexicon?: LexicalContext;
};

export abstract class ScopedNamedEntity extends NamedEntity {
  readonly lexicon: LexicalContext;

  constructor(opts: ScopedNamedEntityOpts) {
    super(opts);
    this.lexicon = opts.lexicon ?? new LexicalContext();
  }

  getCloneOpts(parent?: Expr): ScopedNamedEntityOpts {
    return {
      ...super.getCloneOpts(parent),
      lexicon: this.lexicon,
    };
  }
}
