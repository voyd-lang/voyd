import { FastShiftArray } from "../../lib/fast-shift-array.js";
import { Expr } from "../expr.js";
import { Float } from "../float.js";
import { Id, Identifier } from "../identifier.js";
import { Int } from "../int.js";
import { List, ListValue } from "../list.js";
import { NamedEntity } from "../named-entity.js";
import { getIdStr } from "./get-id-str.js";

export type ChildListValue = Expr | string | number | ChildListValue[];

export class ChildList {
  private store: FastShiftArray<Expr> = new FastShiftArray();
  private parent: Expr;

  constructor(children: ChildListValue[] = [], parent: Expr) {
    this.push(...children);
    this.parent = parent;
  }

  get children() {
    return this.store.toArray();
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
    result.parent = this.parent;
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
  argsArray(): Expr[] {
    return this.store.toArray().slice(1);
  }

  pop(): Expr | undefined {
    return this.store.pop();
  }

  push(...expr: ListValue[]) {
    expr.forEach((ex) => {
      if (typeof ex === "string") {
        this.store.push(new Identifier({ value: ex, parent: this.parent }));
        return;
      }

      if (typeof ex === "number" && Number.isInteger(ex)) {
        this.store.push(new Int({ value: ex, parent: this.parent }));
        return;
      }

      if (typeof ex === "number") {
        this.store.push(new Float({ value: ex, parent: this.parent }));
        return;
      }

      if (ex instanceof Array) {
        this.push(new List({ value: ex, parent: this.parent }));
        return;
      }

      ex.parent = this.parent;

      if (ex instanceof NamedEntity) {
        this.parent.registerEntity(ex);
      }

      if (ex.isList() && ex.calls("splice_quote")) {
        this.store.push(...ex.argsArray());
        return;
      }

      this.store.push(ex);
    });

    return this;
  }

  findIndex(cb: (expr: Expr) => boolean) {
    return this.toArray().findIndex(cb);
  }

  insert(expr: Expr | string, at = 0) {
    const result = typeof expr === "string" ? Identifier.from(expr) : expr;
    result.parent = this.parent;
    this.store.splice(at, 0, result);
    return this;
  }

  remove(index: number, count = 1) {
    this.store.splice(index, count);
    return this;
  }

  filter(fn: (expr: Expr, index: number, array: Expr[]) => boolean): ChildList {
    return new ChildList(this.toArray().filter(fn), this.parent);
  }

  each(fn: (expr: Expr, index: number, array: Expr[]) => void): ChildList {
    this.toArray().forEach(fn);
    return this;
  }

  map(fn: (expr: Expr, index: number, array: Expr[]) => Expr): ChildList {
    return new ChildList(this.toArray().map(fn), this.parent);
  }

  /** Like a regular map, but omits undefined values returned from the mapper */
  mapFilter(
    fn: (expr: Expr, index: number, array: Expr[]) => Expr | undefined
  ): ChildList {
    const list = new ChildList([], this.parent);
    return this.toArray().reduce((newList: ChildList, expr, index, array) => {
      if (!expr) return newList;
      const result = fn(expr, index, array);
      if (!result) return newList;
      return newList.push(result);
    }, list);
  }

  slice(start?: number, end?: number): ChildList {
    return new ChildList(this.store.slice(start, end), this.parent);
  }

  sliceAsArray(start?: number, end?: number) {
    return this.store.slice(start, end);
  }

  toArray() {
    return this.store.toArray();
  }

  toJSON() {
    return this.toArray();
  }

  clone(parent?: Expr) {
    return new ChildList(
      this.toArray().map((expr) => expr.clone()),
      parent ?? this.parent
    );
  }
}
