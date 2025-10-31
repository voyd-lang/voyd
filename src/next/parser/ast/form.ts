import { FastShiftArray } from "@lib/fast-shift-array.js";
import { Expr } from "./expr.js";
import { is, SourceLocation, Syntax, VerboseJSON } from "./syntax.js";
import { IdentifierAtom, InternalIdentifierAtom } from "./atom.js";
import { FormCursor } from "./form-cursor.js";

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
    const normalized: FormOpts = Array.isArray(opts)
      ? { elements: opts }
      : opts;
    super(normalized);
    this.push(...(normalized.elements ?? []));

    if (!this.location) {
      this.location = deriveLocation(this.#elements);
    }
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
    const normalized = elements.map((e) =>
      typeof e === "string"
        ? new IdentifierAtom(e)
        : e instanceof Array
        ? new Form(e)
        : e
    );
    this.#elements.push(...normalized);
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
    const elements = this.toArray().slice(start, end);
    return new Form(elements);
  }

  toArray(): Expr[] {
    return this.#elements.toArray();
  }

  toJSON(): unknown {
    return this.toArray().map((e) => e.toJSON());
  }

  toVerboseJSON(): VerboseJSON {
    return {
      type: this.syntaxType,
      id: this.syntaxId,
      location: this.location?.toJSON(),
      elements: this.#elements.toArray().map((e) => e.toVerboseJSON()),
    };
  }

  static elementsOf(form?: Form): Expr[] {
    return form ? form.toArray() : [];
  }

  callArgs(): Form | undefined {
    const second = this.at(1);
    return is(second, Form) ? second : undefined;
  }

  updateCallArgs(transform: (args: Form) => Form): Form {
    const originalArgs = this.callArgs();
    const baseArgs = originalArgs ?? new Form();
    const nextArgs = transform(baseArgs);

    if (originalArgs && nextArgs === originalArgs) {
      return this;
    }

    if (originalArgs?.location && nextArgs.location === originalArgs.location) {
      nextArgs.setLocation(originalArgs.location.clone());
    }

    const elements = this.toArray();
    const nextElements =
      elements.length >= 2
        ? [elements[0]!, nextArgs, ...elements.slice(2)]
        : [elements[0]!, nextArgs];

    return new Form({
      elements: nextElements,
      location: this.location?.clone(),
    });
  }

  cursor() {
    return FormCursor.fromForm(this);
  }
}

const deriveLocation = (
  elements: FastShiftArray<Expr>
): SourceLocation | undefined => {
  const firstWithLocation = elements.find((expr) => !!expr.location)?.location;
  const lastWithLocation = elements.reverseFind(
    (expr) => !!expr.location
  )?.location;
  if (!firstWithLocation) return undefined;
  const location = firstWithLocation.clone();
  location.setEndToEndOf(lastWithLocation ?? firstWithLocation);
  return location;
};
