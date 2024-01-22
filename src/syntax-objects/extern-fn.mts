import type { Expr } from "./expr.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";
import { Parameter } from "./parameter.mjs";
import { FnType, Type } from "./types.mjs";

export class ExternFn extends NamedEntity {
  readonly syntaxType = "extern-fn";
  readonly parameters: Parameter[] = [];
  readonly namespace: string;
  private returnType: Type;

  constructor(
    opts: NamedEntityOpts & {
      returnType: Type;
      parameters: Parameter[];
      namespace: string;
    }
  ) {
    super(opts);
    this.returnType = opts.returnType;
    this.parameters = opts.parameters ?? [];
    this.namespace = opts.namespace;
  }

  getNameStr(): string {
    return this.name.value;
  }

  getType(): FnType {
    return new FnType({
      ...super.getCloneOpts(this.parent),
      parameters: this.parameters,
      returnType: this.getReturnType(),
    });
  }

  getIndexOfParameter(parameter: Parameter) {
    const index = this.parameters.findIndex(
      (p) => p.syntaxId === parameter.syntaxId
    );
    if (index < 0) {
      throw new Error(`Parameter ${parameter} not registered with fn ${this}`);
    }
    return index;
  }

  getReturnType(): Type {
    if (this.returnType) {
      return this.returnType;
    }

    throw new Error(`Return type not yet resolved for fn ${this}`);
  }

  setReturnType(type: Type) {
    this.returnType = type;
  }

  toString() {
    return this.id;
  }

  clone(parent?: Expr | undefined): ExternFn {
    return new ExternFn({
      ...super.getCloneOpts(parent),
      parameters: this.parameters,
      returnType: this.returnType,
      namespace: this.namespace,
    });
  }

  toJSON() {
    return [
      "extern-fn",
      this.id,
      ["parameters", ...this.parameters],
      ["return-type", this.returnType],
    ];
  }
}
