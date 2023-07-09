import { Expr } from "./expr.mjs";
import { Identifier } from "./identifier.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";
import { Type } from "./types.mjs";

export class Parameter extends NamedEntity {
  /** External label the parameter must be called with e.g. myFunc(label: value) */
  readonly label?: Identifier;
  protected type?: Type;
  readonly syntaxType = "parameter";

  constructor(
    opts: NamedEntityOpts & {
      label?: Identifier;
      type?: Type;
    }
  ) {
    super(opts);
    this.label = opts.label;
    this.type = opts.type;
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
    throw new Error(`Type not yet resolved for variable ${this.name}`);
  }

  setType(type: Type) {
    this.type = type;
  }

  toString() {
    return this.name.toString();
  }

  clone(parent?: Expr | undefined): Parameter {
    return new Parameter({
      ...super.getCloneOpts(parent),
      type: this.type,
      label: this.label,
    });
  }

  toJSON() {
    return ["define-parameter", this.name, ["label", this.label], this.type];
  }
}
