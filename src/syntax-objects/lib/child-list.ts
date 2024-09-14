import { FastShiftArray } from "../../lib/fast-shift-array.js";
import { Expr } from "../expr.js";
import { NamedEntity } from "../named-entity.js";

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

  set(index: number, expr: T) {
    this.registerExpr(expr);
    this.store.set(index, expr);
    return this;
  }

  consume(): T {
    const next = this.store.shift();
    if (!next) throw new Error("No remaining expressions");
    return next;
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

  insert(expr: T, at = 0) {
    this.registerExpr(expr);
    this.store.splice(at, 0, expr);
    return this;
  }

  remove(index: number, count = 1) {
    this.store.splice(index, count);
    return this;
  }

  each(fn: (expr: T, index: number, array: T[]) => void): ChildList<T> {
    this.toArray().forEach(fn);
    return this;
  }

  applyMap(fn: (expr: T, index: number, array: T[]) => T): ChildList<T> {
    this.store.forEach((expr, index, array) => {
      this.set(index, fn(expr, index, array));
    });
    return this;
  }

  slice(start?: number, end?: number): T[] {
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

  reset(to?: T[]) {
    this.store = new FastShiftArray(...(to ?? []));
    return this;
  }

  toArray(): T[] {
    return this.store.toArray();
  }

  clone(): T[] {
    return this.toArray().map((expr: T): T => expr.clone() as T);
  }

  toJSON() {
    return this.toArray();
  }
}
