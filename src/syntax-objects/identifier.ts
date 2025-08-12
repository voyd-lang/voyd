import { Expr } from "./expr.js";
import { NamedEntity } from "./named-entity.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";
import type { Type } from "./types.js";

export type Id = string | Identifier;

export type IdentifierOpts = SyntaxMetadata & {
  value: string;
  isQuoted?: boolean;
};

export class Identifier extends Syntax {
  readonly syntaxType = "identifier";
  /** Is surrounded by single quotes, allows identifiers to have spaces */
  readonly isQuoted?: boolean;
  /** The given name of the identifier */
  value: string;
  type?: Type;

  constructor(opts: string | IdentifierOpts) {
    if (typeof opts === "string") {
      opts = { value: opts };
    }

    super(opts);
    this.isQuoted = opts.isQuoted;
    this.value = opts.value;
  }

  is(v: Id) {
    if (typeof v === "string") {
      return v === this.value;
    }

    return v.value === this.value;
  }

  isDefined() {
    return !!this.resolveEntity(this);
  }

  resolve() {
    return this.resolveEntity(this);
  }

  startsWith(search: string) {
    return this.value.startsWith(search);
  }

  replace(search: string, newVal: string): Identifier {
    return new Identifier({
      ...super.getCloneOpts(),
      value: this.value.replace(search, newVal),
    });
  }

  clone(parent?: Expr): Identifier {
    return new Identifier({
      ...super.getCloneOpts(parent),
      value: this.value,
      isQuoted: this.isQuoted,
    });
  }

  getType() {
    return this.type;
  }

  static from(str: string) {
    return new Identifier({ value: str });
  }

  toString() {
    return this.value;
  }

  toJSON() {
    return this.value;
  }
}

export class MockIdentifier extends Identifier {
  readonly #entity?: NamedEntity;
  constructor(
    opts: IdentifierOpts & {
      entity?: NamedEntity; // The entity this identifier resolves to
    }
  ) {
    super(opts);
    this.#entity = opts.entity;
  }

  resolve() {
    return this.#entity;
  }
}
