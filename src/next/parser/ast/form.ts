import { FastShiftArray } from "@lib/fast-shift-array.js";
import { Expr } from "./expr.js";
import { is, SourceLocation, Syntax, VerboseJSON } from "./syntax.js";
import { IdentifierAtom, InternalIdentifierAtom } from "./atom.js";

export type FormOpts = {
  location?: SourceLocation;
  elements?: FormInitElements;
};

export type FormInitElements = FormInitElement[];
export type FormInitElement = Expr | string | FormInitElement[];
export type FormInit = FormOpts | FormInitElements;

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

  private push(...elements: FormInitElements) {
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

  calls(name: IdentifierAtom | string): boolean {
    const first = this.at(0);
    if (!is(first, IdentifierAtom)) return false;
    return typeof name === "string"
      ? first.value === name
      : name.value === first.value;
  }

  callsInternal(name: InternalIdentifierAtom | string): boolean {
    const first = this.at(0);
    if (!is(first, InternalIdentifierAtom)) return false;
    return typeof name === "string"
      ? first.value === name
      : name.value === first.value;
  }

  at(index: number): Expr | undefined {
    return this.#elements.at(index);
  }

  private get ctor(): new (opts: FormOpts | FormInitElement) => this {
    return this.constructor as new (opts: FormOpts | FormInitElement) => this;
  }

  clone(): this {
    return new this.ctor({
      location: this.location?.clone(),
      elements: this.#elements.toArray().map((e) => e.clone()),
    });
  }

  slice(start?: number, end?: number): Form {
    return new Form(this.toArray().slice(start, end));
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
