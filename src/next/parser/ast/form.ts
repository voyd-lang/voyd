import { FastShiftArray } from "@lib/fast-shift-array.js";
import { Expr } from "./ast.js";
import { is, SourceLocation, Syntax, VerboseJSON } from "./syntax.js";
import { Atom } from "./atom.js";

export type FormOpts = {
  location?: SourceLocation;
  elements?: (Expr | string)[];
};

export class Form extends Syntax {
  #elements = new FastShiftArray<Expr>();

  constructor(opts: FormOpts | (Expr | string)[] = []) {
    if (Array.isArray(opts)) {
      super();
      this.push(...opts);
      return;
    }

    super(opts);
    this.push(...(opts.elements ?? []));
  }

  get last() {
    return this.#elements.at(-1);
  }

  calls(name: Atom | string): boolean {
    const first = this.#elements.at(0);
    if (!is(first, Atom)) return false;
    return typeof name === "string"
      ? first.value === name
      : name.value === first.value;
  }

  at(index: number): Expr | undefined {
    return this.#elements.at(index);
  }

  push(...elements: (Expr | string)[]) {
    this.#elements.push(
      ...elements.map((e) => (typeof e === "string" ? new Atom(e) : e))
    );
  }

  clone(): Form {
    return new Form({
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
      type: "form",
      location: this.location?.toJSON(),
      attributes: this.attributes,
      elements: this.#elements.toArray().map((e) => e.toVerboseJSON()),
    };
  }
}
