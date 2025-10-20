import { FastShiftArray } from "@lib/fast-shift-array.js";
import { Expr } from "./expr.js";
import { is, SourceLocation, Syntax, VerboseJSON } from "./syntax.js";
import { IdentifierAtom } from "./atom.js";

export type FormOpts = {
  location?: SourceLocation;
  elements?: FormElementInitVal;
};

export type FormElementInitVal = (Expr | string | FormElementInitVal)[];
export type FormInit = FormOpts | FormElementInitVal;

export class Form extends Syntax {
  readonly syntaxType: string = "form";
  #elements = new FastShiftArray<Expr>();

  constructor(opts: FormInit = []) {
    if (Array.isArray(opts)) {
      super();
      this.push(...opts);
      return;
    }

    super(opts);
    this.push(...(opts.elements ?? []));
  }

  get length() {
    return this.#elements.length;
  }

  get first() {
    return this.#elements.at(0);
  }

  get last() {
    return this.#elements.at(-1);
  }

  push(...elements: FormElementInitVal) {
    this.#elements.push(
      ...elements.map((e) =>
        typeof e === "string"
          ? new IdentifierAtom(e)
          : e instanceof Array
          ? new Form(e)
          : e
      )
    );
  }

  at(index: number): Expr | undefined {
    return this.#elements.at(index);
  }

  private get ctor(): new (opts: FormOpts | FormElementInitVal) => this {
    return this.constructor as new (
      opts: FormOpts | FormElementInitVal
    ) => this;
  }

  clone(): this {
    return new this.ctor({
      location: this.location?.clone(),
      elements: this.#elements.toArray().map((e) => e.clone()),
    });
  }

  toArray(): Expr[] {
    return this.#elements.toArray();
  }

  toJSON() {
    return this.toArray();
  }

  toVerboseJSON(): VerboseJSON {
    return {
      type: this.syntaxType,
      id: this.syntaxId,
      location: this.location?.toJSON(),
      elements: this.#elements.toArray().map((e) => e.toVerboseJSON()),
    };
  }
}

export class CallForm extends Form {
  readonly syntaxType = "call";

  calls(name: IdentifierAtom | string): boolean {
    const first = this.at(0);
    if (!is(first, IdentifierAtom)) return false;
    return typeof name === "string"
      ? first.value === name
      : name.value === first.value;
  }
}

export class ParenForm extends Form {
  readonly syntaxType = "paren";
}

export class TupleForm extends Form {
  readonly syntaxType = "tuple";
}

export class ArrayLiteralForm extends Form {
  readonly syntaxType = "array-literal";
}

export class LabelForm extends Form {
  readonly syntaxType = "label";
}

export class ObjectLiteralForm extends Form {
  readonly syntaxType = "object-literal";
}
