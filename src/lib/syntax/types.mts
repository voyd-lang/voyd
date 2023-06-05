import { Syntax, SyntaxOpts } from "./syntax.mjs";
import type { Id, Identifier } from "./identifier.mjs";
import { getIdStr } from "./get-id-str.mjs";
import { Expr } from "./expr.mjs";
import { Parameter } from "./parameter.mjs";

export type Type =
  | PrimitiveType
  | UnionType
  | IntersectionType
  | StructType
  | TupleType
  | ArrayType
  | FnType;

export type TypeJSON = ["type", [string, ...any[]]];

export abstract class BaseType extends Syntax {
  readonly syntaxType = "type";
  abstract readonly kindOfType: string;
  /** Size in bytes */
  abstract readonly size: number;

  abstract toJSON(): TypeJSON;
}

export class PrimitiveType extends BaseType {
  readonly kindOfType = "primitive";
  readonly primitiveId: Primitive;

  constructor(opts: SyntaxOpts & { primitiveId: Primitive }) {
    super(opts);
    this.primitiveId = opts.primitiveId;
  }

  get size() {
    if (this.primitiveId === "i32") return 4;
    if (this.primitiveId === "f32") return 4;
    if (this.primitiveId === "i64") return 8;
    if (this.primitiveId === "f64") return 8;
    return 0;
  }

  static from(id: Primitive) {
    return new PrimitiveType({ primitiveId: id });
  }

  clone(parent?: Expr): PrimitiveType {
    return new PrimitiveType({
      parent,
      inherit: this,
      primitiveId: this.primitiveId,
    });
  }

  toJSON(): TypeJSON {
    return ["type", ["primitive", this.primitiveId]];
  }
}

export class UnionType extends BaseType {
  readonly kindOfType = "union";
  value: Type[];

  constructor(opts: SyntaxOpts & { value: Type[] }) {
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
    return new UnionType({ parent, value: this.value, inherit: this });
  }

  toJSON(): TypeJSON {
    return ["type", ["union", ...this.value]];
  }
}

export class IntersectionType extends BaseType {
  readonly kindOfType = "intersection";
  value: Type[];

  constructor(opts: SyntaxOpts & { value: Type[] }) {
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
    return new IntersectionType({ parent, value: this.value, inherit: this });
  }

  toJSON(): TypeJSON {
    return ["type", ["intersection", ...this.value]];
  }
}

export class TupleType extends BaseType {
  readonly kindOfType = "tuple";
  value: Type[];

  constructor(opts: SyntaxOpts & { value: Type[] }) {
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
    return new TupleType({ parent, value: this.value, inherit: this });
  }

  toJSON(): TypeJSON {
    return ["type", ["tuple", ...this.value]];
  }
}

export class StructType extends BaseType {
  readonly kindOfType = "struct";
  value: { name: string; type: Type }[];

  constructor(opts: SyntaxOpts & { value: { name: string; type: Type }[] }) {
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
      ["struct", ...this.value.map(({ name, type }) => [name, type])],
    ];
  }

  clone(parent?: Expr): StructType {
    return new StructType({ parent, value: this.value, inherit: this });
  }
}

export class ArrayType extends BaseType {
  readonly kindOfType = "array";
  readonly size = Infinity;
  value: Type;

  constructor(opts: SyntaxOpts & { value: Type }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): ArrayType {
    return new ArrayType({ parent, value: this.value, inherit: this });
  }

  toJSON(): TypeJSON {
    return ["type", ["array", this.value]];
  }
}

export class FnType extends BaseType {
  readonly kindOfType = "fn";
  readonly size = 0;
  readonly fnId: string;
  readonly identifier: Identifier;
  readonly parameters: Parameter[];
  readonly returnType: Type;

  constructor(
    opts: SyntaxOpts & {
      fnId: string;
      identifier: Identifier;
      parameters: Parameter[];
      returnType: Type;
    }
  ) {
    super(opts);
    this.fnId = opts.fnId;
    this.identifier = opts.identifier;
    this.parameters = opts.parameters;
    this.returnType = opts.returnType;
  }

  clone(parent?: Expr): FnType {
    return new FnType({
      parent,
      inherit: this,
      identifier: this.identifier,
      returnType: this.returnType,
      parameters: this.parameters,
      fnId: this.fnId,
    });
  }

  toJSON(): TypeJSON {
    return [
      "type",
      [
        "fn",
        this.fnId,
        ["parameters", this.parameters],
        ["return-type", this.returnType],
      ],
    ];
  }
}

// TODO add structs
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
