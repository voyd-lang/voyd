import { Expr } from "./expr.mjs";
import { Identifier } from "./identifier.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";
import { Type } from "./types.mjs";

export class Parameter extends Syntax {
  readonly identifier: Identifier;
  readonly label?: Identifier;
  readonly isMutable: boolean;
  protected type?: Type;
  readonly syntaxType = "parameter";
  readonly initializer?: Expr;

  constructor(
    opts: SyntaxOpts & {
      /** Identifier used to refer to the parameter from within the function */
      identifier: Identifier;
      /** External label the parameter must be called with e.g. myFunc(label: value) */
      label?: Identifier;
      isMutable: boolean;
      initializer?: Expr;
      type?: Type;
    }
  ) {
    super(opts);
    this.identifier = opts.identifier;
    this.label = opts.label;
    this.isMutable = opts.isMutable;
    this.type = opts.type;
    this.initializer = opts.initializer;
  }

  getReadableId() {
    return `${this.location?.filePath ?? "unknown"}/${this.identifier.value}`;
  }

  getIndex(): number {
    const index = this.parentFn?.getIndexOfParameter(this) ?? -1;
    if (index < -1) {
      throw new Error(`Parameter ${this} is not registered with a function`);
    }
    return index;
  }

  getType(): Type {
    if (this.type) return this.type;
    throw new Error(`Type not yet resolved for variable ${this.identifier}`);
  }

  setType(type: Type) {
    this.type = type;
  }

  toString() {
    return this.identifier.toString();
  }

  clone(parent?: Expr | undefined): Parameter {
    return new Parameter({
      location: this.location,
      inherit: this,
      parent: parent ?? this.parent,
      identifier: this.identifier,
      isMutable: this.isMutable,
      initializer: this.initializer,
      type: this.type,
      label: this.label,
    });
  }

  toJSON() {
    return [
      "define-parameter",
      this.identifier,
      ["label", this.label],
      this.type,
      ["is-mutable", this.isMutable],
      this.initializer,
    ];
  }
}
