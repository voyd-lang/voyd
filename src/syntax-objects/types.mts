import { Expr } from "./expr.mjs";
import { Parameter } from "./parameter.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";

export type Type =
  | PrimitiveType
  | UnionType
  | IntersectionType
  | ObjectType
  | TupleType
  | ArrayType
  | FnType
  | TypeAlias;

export type TypeJSON = ["type", [string, ...any[]]];

export abstract class BaseType extends NamedEntity {
  readonly syntaxType = "type";
  abstract readonly kindOfType: string;
  /** Size in bytes */
  abstract readonly size: number;

  abstract toJSON(): TypeJSON;
}

export class TypeAlias extends BaseType {
  readonly kindOfType = "type-alias";
  readonly size = 4;
  typeExpr: Expr;

  constructor(opts: NamedEntityOpts & { typeExpr: Expr }) {
    super(opts);
    this.typeExpr = opts.typeExpr;
  }

  toJSON(): TypeJSON {
    return ["type", ["type-alias", this.typeExpr]];
  }

  clone(parent?: Expr | undefined): TypeAlias {
    return new TypeAlias({
      ...super.getCloneOpts(parent),
      typeExpr: this.typeExpr,
    });
  }
}

export class PrimitiveType extends BaseType {
  readonly kindOfType = "primitive";

  constructor(opts: NamedEntityOpts) {
    super(opts);
  }

  get size() {
    if (this.name.value === "i32") return 4;
    if (this.name.value === "f32") return 4;
    if (this.name.value === "i64") return 8;
    if (this.name.value === "f64") return 8;
    return 0;
  }

  static from(name: Primitive) {
    return new PrimitiveType({ name });
  }

  clone(parent?: Expr): PrimitiveType {
    return new PrimitiveType({ ...super.getCloneOpts(parent) });
  }

  toJSON(): TypeJSON {
    return ["type", ["primitive", this.name]];
  }
}

export class UnionType extends BaseType {
  readonly kindOfType = "union";
  value: Type[];

  constructor(opts: NamedEntityOpts & { value: Type[] }) {
    super(opts);
    this.value = opts.value;
  }

  get size() {
    let max = 0;
    for (const type of this.value) {
      if (type.size > max) max = type.size;
    }
    return max;
  }

  clone(parent?: Expr): UnionType {
    return new UnionType({ ...super.getCloneOpts(parent), value: this.value });
  }

  toJSON(): TypeJSON {
    return ["type", ["union", ...this.value]];
  }
}

export class IntersectionType extends BaseType {
  readonly kindOfType = "intersection";
  value: Type[];

  constructor(opts: NamedEntityOpts & { value: Type[] }) {
    super(opts);
    this.value = opts.value;
  }

  get size() {
    let total = 0;
    for (const type of this.value) {
      total += type.size;
    }
    return total;
  }

  clone(parent?: Expr): IntersectionType {
    return new IntersectionType({
      ...super.getCloneOpts(parent),
      value: this.value,
    });
  }

  toJSON(): TypeJSON {
    return ["type", ["intersection", ...this.value]];
  }
}

export class TupleType extends BaseType {
  readonly kindOfType = "tuple";
  value: Type[];

  constructor(opts: NamedEntityOpts & { value: Type[] }) {
    super(opts);
    this.value = opts.value;
  }

  get size() {
    let total = 0;
    for (const type of this.value) {
      total += type.size;
    }
    return total;
  }

  clone(parent?: Expr): TupleType {
    return new TupleType({ ...super.getCloneOpts(parent), value: this.value });
  }

  toJSON(): TypeJSON {
    return ["type", ["tuple", ...this.value]];
  }
}

export class ObjectType extends BaseType {
  readonly kindOfType = "object";
  value: { name: string; type: Type }[];

  constructor(
    opts: NamedEntityOpts & { value: { name: string; type: Type }[] }
  ) {
    super(opts);
    this.value = opts.value;
  }

  get size() {
    let total = 0;
    for (const field of this.value) {
      total += field.type.size;
    }
    return total;
  }

  toJSON(): TypeJSON {
    return [
      "type",
      ["object", ...this.value.map(({ name, type }) => [name, type])],
    ];
  }

  clone(parent?: Expr): ObjectType {
    return new ObjectType({ ...super.getCloneOpts(parent), value: this.value });
  }
}

export class ArrayType extends BaseType {
  readonly kindOfType = "array";
  readonly size = Infinity;
  value: Type;

  constructor(opts: NamedEntityOpts & { value: Type }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): ArrayType {
    return new ArrayType({ ...super.getCloneOpts(parent), value: this.value });
  }

  toJSON(): TypeJSON {
    return ["type", ["array", this.value]];
  }
}

export class FnType extends BaseType {
  readonly kindOfType = "fn";
  readonly size = 0;
  readonly parameters: Parameter[];
  readonly returnType: Type;

  constructor(
    opts: NamedEntityOpts & {
      parameters: Parameter[];
      returnType: Type;
    }
  ) {
    super(opts);
    this.parameters = opts.parameters;
    this.returnType = opts.returnType;
  }

  clone(parent?: Expr): FnType {
    return new FnType({
      ...super.getCloneOpts(parent),
      returnType: this.returnType,
      parameters: this.parameters,
    });
  }

  toJSON(): TypeJSON {
    return [
      "type",
      [
        "fn",
        this.id,
        ["parameters", this.parameters],
        ["return-type", this.returnType],
      ],
    ];
  }
}

export type StackType = NumericType | ReferenceType;
export type Primitive = NumericType | ReferenceType | "void";
export type NumericType = "i32" | "f32" | "i64" | "f64";
export type ReferenceType = "funcref" | "externref";

export const i32 = PrimitiveType.from("i32");
export const f32 = PrimitiveType.from("f32");
export const i64 = PrimitiveType.from("i64");
export const f64 = PrimitiveType.from("f64");
export const bool = PrimitiveType.from("i32");
export const dVoid = PrimitiveType.from("void");
export const CDT_ADDRESS_TYPE = i32;
