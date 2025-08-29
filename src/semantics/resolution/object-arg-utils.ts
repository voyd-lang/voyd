import { Call } from "../../syntax-objects/call.js";
import { Block } from "../../syntax-objects/block.js";
import { Expr, Identifier, List } from "../../syntax-objects/index.js";
import { ObjectLiteral } from "../../syntax-objects/object-literal.js";
import { Variable } from "../../syntax-objects/variable.js";
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
 * `expected`, returns an expression that yields an object literal where each
 * field is initialized via a member-access from `objArg`. The supplied
 * argument is evaluated at most once. Otherwise returns undefined.
 */
export const maybeExpandObjectArg = (
  objArg: Expr,
  expected: ObjectType,
  metadata: Record<string, unknown>
): Expr | undefined => {
  if (objArg.isObjectLiteral()) return undefined;

  const objType = getExprType(objArg);
  const structType = getStructuralType(objType);
  if (!structType) return undefined;

  if (!expected.fields.every((f) => structType.hasField(f.name))) {
    return undefined;
  }

  const makeLiteral = (recv: Expr) =>
    new ObjectLiteral({
      ...metadata,
      fields: expected.fields.map((f) => ({
        name: f.name,
        initializer: new Call({
          ...metadata,
          fnName: Identifier.from("member-access"),
          args: new List({ value: [recv.clone(), Identifier.from(f.name)] }),
        }),
      })),
    });

  if (objArg.isIdentifier()) return makeLiteral(objArg);

  const tmpId = Identifier.from(`obj_${objArg.syntaxId}`);
  const tmpVar = new Variable({
    ...metadata,
    name: tmpId.clone(),
    isMutable: false,
    initializer: objArg,
  });
  const obj = makeLiteral(tmpId);
  return new Block({ ...metadata, body: [tmpVar, obj] });
};

