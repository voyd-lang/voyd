import { FastShiftArray } from "../../lib/fast-shift-array.js";
import { Expr } from "../expr.js";
import { Id, Identifier } from "../identifier.js";
import { List } from "../list.js";
import { NamedEntity } from "../named-entity.js";
import { getIdStr } from "./get-id-str.js";

export class ChildList<T extends Expr = Expr> {
  private store: FastShiftArray<T> = new FastShiftArray();
  #parent: Expr;

  constructor(children: T[] = [], parent: Expr) {
    this.#parent = parent;
    this.push(...children);
  }

  get parent() {
    return this.#parent;
  }

  set parent(parent: Expr) {
    this.#parent = parent;
    this.store.forEach((expr) => {
      expr.parent = parent;
    });
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

  private registerExpr(expr: T) {
    expr.parent = this.parent;
    if (expr instanceof NamedEntity) {
      this.parent.registerEntity(expr);
    }
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

  set(index: number, expr: T) {
    this.registerExpr(expr);
    this.store.set(index, expr);
    return this;
  }

  calls(fnId: Id, atIndex = 0) {
    return this.getIdStrAt(atIndex) === getIdStr(fnId);
  }

  getIdStrAt(index: number): string | undefined {
    const v = this.at(index);
    return v?.isIdentifier() || v?.isStringLiteral() ? v.value : undefined;
  }

  consume(): T {
    const next = this.store.shift();
    if (!next) throw new Error("No remaining expressions");
    return next;
  }

  first(): T | undefined {
    return this.store.at(0);
  }

  last(): T | undefined {
    return this.store.at(-1);
  }

  /** Returns all but the first element in an array */
  argsArray(): T[] {
    return this.store.toArray().slice(1);
  }

  pop(): T | undefined {
    return this.store.pop();
  }

  push(...expr: T[]) {
    expr.forEach((ex) => {
      this.registerExpr(ex);
      this.store.push(ex);
    });
    return this;
  }

  findIndex(cb: (expr: Expr) => boolean) {
    return this.toArray().findIndex(cb);
  }

  insert(expr: T, at = 0) {
    this.registerExpr(expr);
    this.store.splice(at, 0, expr);
    return this;
  }

  remove(index: number, count = 1) {
    this.store.splice(index, count);
    return this;
  }

  filter(fn: (expr: T, index: number, array: T[]) => boolean): ChildList<T> {
    return new ChildList(this.toArray().filter(fn), this.parent);
  }

  each(fn: (expr: T, index: number, array: T[]) => void): ChildList<T> {
    this.toArray().forEach(fn);
    return this;
  }

  map(fn: (expr: T, index: number, array: T[]) => T): ChildList<T> {
    return new ChildList(this.toArray().map(fn), this.parent);
  }

  applyMap(fn: (expr: T, index: number, array: T[]) => T): ChildList<T> {
    this.store.forEach((expr, index, array) => {
      this.set(index, fn(expr, index, array));
    });
    return this;
  }

  /** Like a regular map, but omits undefined values returned from the mapper */
  mapFilter(
    fn: (expr: T, index: number, array: T[]) => T | undefined
  ): ChildList<T> {
    const list = new ChildList([], this.parent);
    return this.toArray().reduce(
      (newList: ChildList<T>, expr, index, array) => {
        if (!expr) return newList;
        const result = fn(expr, index, array);
        if (!result) return newList;
        return newList.push(result);
      },
      list
    );
  }

  slice(start?: number, end?: number): ChildList<T> {
    return new ChildList(this.store.slice(start, end), this.parent);
  }

  sliceAsArray(start?: number, end?: number) {
    return this.store.slice(start, end);
  }

  shift(): T | undefined {
    return this.store.shift();
  }

  unshift(...expr: T[]) {
    expr.forEach((ex) => {
      this.registerExpr(ex);
      this.store.unshift(ex);
    });

    return this;
  }

  toArray(): T[] {
    return this.store.toArray();
  }

  toJSON() {
    return this.toArray();
  }

  clone(parent?: Expr): ChildList<T> {
    return new ChildList<T>(
      this.toArray().map((expr) => expr.clone()) as T[],
      parent ?? this.parent
    );
  }
}
