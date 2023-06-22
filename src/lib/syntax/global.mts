import { Expr } from "./expr.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";
import { Type } from "./types.mjs";

export class Global extends NamedEntity {
  /** Absolute unique id */
  readonly id: string;
  readonly isMutable: boolean;
  protected type?: Type;
  readonly syntaxType = "global";
  readonly initializer?: Expr;

  constructor(
    opts: NamedEntityOpts & {
      isMutable: boolean;
      initializer?: Expr;
      type?: Type;
      id?: string;
    }
  ) {
    super(opts);
    this.isMutable = opts.isMutable;
    this.type = opts.type;
    this.initializer = opts.initializer;
    this.id = opts.id ?? this.generateId();
  }

  private generateId() {
    return `${this.location?.filePath ?? "unknown"}/${this.name.value}#${
      this.syntaxId
    }`;
  }

  getType(): Type {
    if (this.type) return this.type;
    throw new Error(`Type not yet resolved for global ${this.name}`);
  }

  setType(type: Type) {
    this.type = type;
  }

  toString() {
    return this.name.toString();
  }

  toJSON() {
    return [
      "define-global",
      this.name,
      this.type,
      ["is-mutable", this.isMutable],
      this.initializer,
    ];
  }

  clone(parent?: Expr | undefined): Global {
    return new Global({
      inherit: this,
      parent: parent ?? this.parent,
      name: this.name,
      isMutable: this.isMutable,
      initializer: this.initializer,
      type: this.type,
      id: this.id,
    });
  }
}
