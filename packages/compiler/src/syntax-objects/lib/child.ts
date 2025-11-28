import { Expr } from "../expr.js";
import { NamedEntity } from "../named-entity.js";

/** Use to store a child of a syntax object. Will keep track of parent */
export class Child<T extends Expr | undefined> {
  #value: T;
  #parent: Expr;

  constructor(value: T, parent: Expr) {
    this.#parent = parent;
    this.#value = value;
    if (this.#value) this.#value.parent = parent;
  }

  get parent() {
    return this.#parent;
  }

  set parent(parent: Expr) {
    this.#parent = parent;
    if (this.#value) this.#value.parent = parent;
  }

  get value() {
    return this.#value;
  }

  set value(value: T) {
    if (value) {
      if (value instanceof NamedEntity) this.#parent.registerEntity(value);
      value.parent = this.#parent;
    }

    this.#value = value;
  }

  toJSON() {
    return this.#value?.toJSON();
  }

  clone(parent?: Expr): T {
    return this.#value?.clone(parent) as T;
  }
}
