import { Call } from "../../syntax-objects/call.js";
import { Expr, Identifier, List } from "../../syntax-objects/index.js";
import { ObjectLiteral } from "../../syntax-objects/object-literal.js";
import { ObjectType, Type } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";

const getStructuralType = (t?: Type): ObjectType | undefined => {
  if (!t) return undefined;
  if (t.isObjectType()) return t;
  if (t.isIntersectionType()) return t.structuralType ?? undefined;
  return undefined;
};

/**
 * If `objArg` is a non-literal object that structurally provides all fields of
 * `expected`, returns an object literal where each field is initialized via a
 * member-access from `objArg`. Otherwise returns undefined.
 */
export const maybeExpandObjectArg = (
  objArg: Expr,
  expected: ObjectType,
  metadata: Record<string, unknown>
): ObjectLiteral | undefined => {
  if (objArg.isObjectLiteral()) return undefined;

  const objType = getExprType(objArg);
  const structType = getStructuralType(objType);
  if (!structType) return undefined;

  if (!expected.fields.every((f) => structType.hasField(f.name))) {
    return undefined;
  }

  const fields = expected.fields.map((f) => ({
    name: f.name,
    initializer: new Call({
      ...metadata,
      fnName: Identifier.from("member-access"),
      args: new List({ value: [objArg.clone(), Identifier.from(f.name)] }),
    }),
  }));

  return new ObjectLiteral({ ...metadata, fields });
};

