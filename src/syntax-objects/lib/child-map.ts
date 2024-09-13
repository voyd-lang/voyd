import { Expr } from "../expr.js";

export class ChildMap<T extends { [key: string]: Expr }> {
  private map: T;
  private parent: Expr;

  constructor(map: T, parent: Expr) {
    this.parent = parent;
    this.map = Object.fromEntries(
      Object.entries(map).map(([key, value]) => {
        value.parent = parent;
        return [key, value];
      })
    ) as T;
  }

  get(key: keyof T): T[keyof T] {
    return this.map[key];
  }

  set(key: keyof T, value: T[keyof T]) {
    this.map[key] = value;
    value.parent = this.parent;
  }

  toJSON() {
    return this.map;
  }

  clone(parent?: Expr) {
    parent = parent ?? this.parent;
    const newMap: T = Object.fromEntries(
      Object.entries(this.map).map(([key, value]) => [key, value.clone(parent)])
    ) as T;
    return new ChildMap(newMap, parent);
  }
}
