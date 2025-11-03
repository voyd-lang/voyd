import { FastShiftArray } from "@lib/fast-shift-array.js";
import { Expr } from "./expr.js";
import { SourceLocation, Syntax, VerboseJSON } from "./syntax.js";
import { IdentifierAtom, InternalIdentifierAtom } from "./atom.js";
import { FormCursor } from "./form-cursor.js";
import {
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "./predicates.js";
import { Internal } from "./internals.js";

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

  get rest() {
    return this.#elements.slice(1);
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
    if (!isIdentifierAtom(this.first)) return false;
    return this.first.eq(name);
  }

  callsInternal(name: InternalIdentifierAtom | Internal): boolean {
    if (!isInternalIdentifierAtom(this.first)) return false;
    return this.first.eq(name);
  }

  /** Alias for callsInternal */
  iCall(name: InternalIdentifierAtom | Internal) {
    return this.callsInternal(name);
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

  append(expr: Expr): Form {
    return new Form([...this.toArray(), expr]);
  }

  insert(expr: Expr | Internal, at = 0): Form {
    if (typeof expr === "string") expr = new InternalIdentifierAtom(expr);
    return new Form(this.toArray().toSpliced(at, 0, expr));
  }

  split(delimiter = ","): Form {
    const groups: (Expr[] | Expr)[] = [];
    let current: Expr[] = [];

    for (const element of this.toArray()) {
      if (isIdentifierAtom(element) && element.eq(delimiter)) {
        if (current.length) groups.push(unwrapArray(current));
        current = [];
        continue;
      }

      current.push(element);
    }

    if (current.length) groups.push(unwrapArray(current));
    return new Form(groups);
  }

  replaceFirst(expr: Expr) {
    return new Form({
      location: this.location,
      elements: [expr, ...this.rest],
    });
  }

  /** If this Form only contains a single child that itself is a form, returns the child, otherwise returns this form */
  unwrap(): Form {
    if (this.length === 1 && isForm(this.first)) return this.first;
    return this;
  }

  /**
   * Converts the Form into a function call of the provided name by separating
   * parameters between commas and inserting the name as the first element */
  toCallOf(name: Internal): Form {
    return this.split().insert(name);
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

  cursor() {
    return FormCursor.fromForm(this);
  }

  static elementsOf(form?: Form): Expr[] {
    return form ? form.toArray() : [];
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

/** Turns [[]] -> [] and keeps [[], []] as [[], []] */
const unwrapArray = <T>(arr: T[]): T | T[] => {
  if (arr.length === 1) {
    return arr.at(0)!;
  }

  return arr;
};
