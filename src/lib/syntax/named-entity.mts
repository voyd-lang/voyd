import { Expr } from "./expr.mjs";
import { Id, Identifier } from "./identifier.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export type NamedEntityOpts = SyntaxOpts & { name: Id; id?: string };

export abstract class NamedEntity extends Syntax {
  readonly id: string;
  readonly name: Identifier;

  constructor(opts: NamedEntityOpts) {
    super(opts);
    this.name =
      typeof opts.name === "string" ? Identifier.from(opts.name) : opts.name;
    this.id = opts.id ?? this.genId();
  }

  private genId() {
    return `${this.location?.filePath ?? "unknown"}/${this.name}#${
      this.syntaxId
    }`;
  }

  protected getCloneOpts(parent?: Expr): NamedEntityOpts {
    return { id: this.id, name: this.name, inherit: this, parent };
  }
}
