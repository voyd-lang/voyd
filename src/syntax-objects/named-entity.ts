import { Expr } from "./expr.js";
import { Id, Identifier } from "./identifier.js";
import { LexicalContext } from "./lexical-context.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export type NamedEntityOpts = SyntaxMetadata & {
  name: Id;
  id?: string;
  isExported?: boolean;
};

export abstract class NamedEntity extends Syntax {
  id: string;
  name: Identifier;
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

  setName(name: string) {
    this.name = Identifier.from(name);
    this.id = this.genId();
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
