import { Expr } from "./expr.mjs";
import { Id, Identifier } from "./identifier.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export type NamedEntityOpts = SyntaxOpts & {
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
