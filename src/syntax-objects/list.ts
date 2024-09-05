import { FastShiftArray } from "../lib/fast-shift-array.js";
import { Expr } from "./expr.js";
import { Float } from "./float.js";
import { getIdStr } from "./get-id-str.js";
import { Id, Identifier } from "./identifier.js";
import { Int } from "./int.js";
import { NamedEntity } from "./named-entity.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export class List extends Syntax {
  readonly syntaxType = "list";
  /** True when the list was defined by the user using parenthesis i.e. (hey, there) */
  mayBeTuple?: boolean;
  store: FastShiftArray<Expr> = new FastShiftArray();

  constructor(
    opts:
      | ListValue[]
      | (SyntaxMetadata & {
          value?: ListValue[] | List;
          isParentheticalList?: boolean;
        })
  ) {
    opts = Array.isArray(opts) ? { value: opts } : opts;
    super(opts);

    const value = opts.value;
    this.mayBeTuple = opts.isParentheticalList;

    if (!value || value instanceof Array) {
      this.push(...(value ?? []));
    } else {
      this.push(...value.toArray());
    }
  }
  get hasChildren() {
    return !!this.store.length;
  }

  get length() {
    return this.store.length;
  }

  at(index: number): Expr | undefined {
    return this.store.at(index);
  }

  exprAt(index: number): Expr {
    const expr = this.store.at(index);
    if (!expr) {
      throw new Error(`No expr at ${index}`);
    }
    return expr;
  }

  identifierAt(index: number): Identifier {
    const id = this.at(index);
    if (!id?.isIdentifier()) {
      throw new Error(`No identifier at index ${index}`);
    }
    return id;
  }

  optionalIdentifierAt(index: number): Identifier | undefined {
    const id = this.at(index);
    if (id?.isIdentifier()) {
      return id;
    }
  }

  listAt(index: number): List {
    const id = this.at(index);
    if (!id?.isList()) {
      throw new Error(`No list at index ${index}`);
    }
    return id;
  }

  set(index: number, expr: Expr | string) {
    const result = typeof expr === "string" ? Identifier.from(expr) : expr;
    result.parent = this;
    this.store.set(index, result);
    return this;
  }

  calls(fnId: Id, atIndex = 0) {
    return this.getIdStrAt(atIndex) === getIdStr(fnId);
  }

  getIdStrAt(index: number): string | undefined {
    const v = this.at(index);
    return v?.isIdentifier() || v?.isStringLiteral() ? v.value : undefined;
  }

  consume(): Expr {
    const next = this.store.shift();
    if (!next) throw new Error("No remaining expressions");
    return next;
  }

  first(): Expr | undefined {
    return this.store.at(0);
  }

  last(): Expr | undefined {
    return this.store.at(-1);
  }

  /** Returns all but the first element in an array */
  rest(): Expr[] {
    return this.store.toArray().slice(1);
  }

  pop(): Expr | undefined {
    return this.store.pop();
  }

  push(...expr: ListValue[]) {
    expr.forEach((ex) => {
      if (typeof ex === "string") {
        this.store.push(new Identifier({ value: ex, parent: this }));
        return;
      }

      if (typeof ex === "number" && Number.isInteger(ex)) {
        this.store.push(new Int({ value: ex, parent: this }));
        return;
      }

      if (typeof ex === "number") {
        this.store.push(new Float({ value: ex, parent: this }));
        return;
      }

      if (ex instanceof Array) {
        this.push(new List({ value: ex, parent: this }));
        return;
      }

      ex.parent = this;

      if (ex instanceof NamedEntity) {
        this.registerEntity(ex);
      }

      if (ex.isList() && ex.calls("splice_quote")) {
        this.store.push(...ex.rest());
        return;
      }

      this.store.push(ex);
    });

    return this;
  }

  findIndex(cb: (expr: Expr) => boolean) {
    return this.toArray().findIndex(cb);
  }

  insertFnCall(name: string) {
    this.insert(name, 0).insert(",", 1);
    return this;
  }

  insert(expr: Expr | string, at = 0) {
    const result = typeof expr === "string" ? Identifier.from(expr) : expr;
    result.parent = this;
    this.store.splice(at, 0, result);
    return this;
  }

  remove(index: number, count = 1) {
    this.store.splice(index, count);
    return this;
  }

  filter(fn: (expr: Expr, index: number, array: Expr[]) => boolean): List {
    return new List({
      ...super.getCloneOpts(),
      value: this.toArray().filter(fn),
    });
  }

  each(fn: (expr: Expr, index: number, array: Expr[]) => void): List {
    this.toArray().forEach(fn);
    return this;
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): List {
    return new List({
      ...super.getCloneOpts(),
      value: this.toArray().map(fn),
    });
  }

  /** Like a regular map, but omits undefined values returned from the mapper */
  mapFilter(
    fn: (expr: Expr, index: number, array: Expr[]) => Expr | undefined
  ): List {
    const list = new List({ ...super.getCloneOpts() });
    return this.toArray().reduce((newList: List, expr, index, array) => {
      if (!expr) return newList;
      const result = fn(expr, index, array);
      if (!result) return newList;
      return newList.push(result);
    }, list);
  }

  slice(start?: number, end?: number): List {
    return new List({
      ...super.getCloneOpts(),
      value: this.store.slice(start, end),
    });
  }

  sliceAsArray(start?: number, end?: number) {
    return this.store.slice(start, end);
  }

  toArray(): Expr[] {
    return this.store.toArray();
  }

  toJSON() {
    return this.toArray();
  }

  /** Clones should return a deep copy of all expressions except for type expressions */
  clone(parent?: Expr): List {
    return new List({
      ...super.getCloneOpts(parent),
      value: this.toArray().map((v) => v.clone()),
      isParentheticalList: this.mayBeTuple,
    });
  }
}

export type ListValue = Expr | string | number | ListValue[];
