import { Expr } from "./expr.js";
import { Identifier, Id } from "./identifier.js";
import { Implementation } from "./implementation.js";
import { getIdStr } from "./lib/get-id-str.js";
import { LexicalContext } from "./lib/lexical-context.js";
import { NamedEntityOpts } from "./named-entity.js";
import { ScopedEntity } from "./scoped-entity.js";
import { Type, TypeJSON } from "./types.js";
import { BaseType } from "./types/base-type.js";

export type ObjectField = {
  name: string;
  typeExpr: Expr;
  type?: Type;
  binaryenGetterType?: number;
  binaryenSetterType?: number;
};

export class Obj extends BaseType implements ScopedEntity {
  readonly kindOfType = "object";
  lexicon: LexicalContext = new LexicalContext();
  typeParameters?: Identifier[];
  resolvedTypeArgs?: Type[];
  genericInstances?: Obj[];
  /** If this is a genericInstance of an object, this is the generic version itself that it was generated from */
  genericParent?: Obj;
  fields: ObjectField[];
  parentObjExpr?: Expr;
  parentObjType?: Obj;
  /** Type used for locals, globals, function return type */
  binaryenType?: number;
  typesResolved?: boolean; // Don't set if type parameters are present
  implementations: Implementation[];
  isStructural = false;
  #iteration = 0;

  constructor(
    opts: NamedEntityOpts & {
      fields: ObjectField[];
      parentObjExpr?: Expr;
      parentObj?: Obj;
      typeParameters?: Identifier[];
      implementations?: Implementation[];
      isStructural?: boolean;
    }
  ) {
    super(opts);
    this.fields = opts.fields;
    this.fields.forEach((field) => {
      field.typeExpr.parent = this;
    });
    this.parentObjType = opts.parentObj;
    this.parentObjExpr = opts.parentObjExpr;
    this.typeParameters = opts.typeParameters;
    this.implementations = opts.implementations ?? [];
    this.isStructural = opts.isStructural ?? false;
  }

  get size() {
    return 4;
  }

  toJSON(): TypeJSON {
    return [
      "type",
      [
        "object",
        this.id,
        ...this.fields.map(({ name, typeExpr }) => [name, typeExpr]),
      ],
    ];
  }

  clone(parent?: Expr): Obj {
    return new Obj({
      ...super.getCloneOpts(parent),
      id: `${this.id}#${this.#iteration++}`,
      fields: this.fields.map((field) => ({
        ...field,
        typeExpr: field.typeExpr.clone(),
        type: field.type?.clone(),
      })),
      parentObjExpr: this.parentObjExpr?.clone(),
      typeParameters: this.typeParameters,
      implementations: this.implementations.map((impl) => impl.clone()),
      isStructural: this.isStructural,
    });
  }

  extends(ancestor: Obj): boolean {
    if (this === ancestor) {
      return true;
    }

    if (this.parentObjType) {
      return this.parentObjType.extends(ancestor);
    }

    return false;
  }

  // Register a version of this function with resolved generics
  registerGenericInstance(obj: Obj) {
    if (!this.genericInstances) {
      this.genericInstances = [];
    }

    this.genericInstances.push(obj);
  }

  getAncestorIds(start: number[] = []): number[] {
    // Always include this object's id
    start.push(this.idNum);
    // For generic instances, also include the generic parent id so that
    // runtime extends checks (used by union matching, e.g., MsgPack cases)
    // succeed across all instantiations of the same nominal type.
    if (this.genericParent) {
      start.push(this.genericParent.idNum);
    }
    if (this.parentObjType) {
      return this.parentObjType.getAncestorIds(start);
    }
    return start;
  }

  hasField(name: Id) {
    return this.fields.some((field) => field.name === getIdStr(name));
  }

  getField(name: Id) {
    return this.fields.find((field) => field.name === getIdStr(name));
  }

  getFieldIndex(name: Id) {
    return this.fields.findIndex((field) => field.name === getIdStr(name));
  }
}
