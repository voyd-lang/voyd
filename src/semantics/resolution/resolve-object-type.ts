import { Call } from "../../syntax-objects/call.js";
import { nop } from "../../syntax-objects/helpers.js";
import { List } from "../../syntax-objects/list.js";
import {
  ObjectType,
  TypeAlias,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { implIsCompatible, resolveImpl } from "./resolve-impl.js";
import { resolveTypes } from "./resolve-types.js";
import { typesAreCompatible } from "./types-are-compatible.js";

export const resolveObjectTypeTypes = (
  obj: ObjectType,
  call?: Call
): ObjectType => {
  if (obj.typesResolved) return obj;

  if (obj.typeParameters) {
    return resolveGenericObjVersion(obj, call) ?? obj;
  }

  obj.fields.forEach((field) => {
    field.typeExpr = resolveTypes(field.typeExpr);
    field.type = getExprType(field.typeExpr);
  });

  if (obj.parentObjExpr) {
    const parentType = getExprType(obj.parentObjExpr);
    obj.parentObjType = parentType?.isObjectType() ? parentType : undefined;
  } else {
    obj.parentObjType = voydBaseObject;
  }

  obj.typesResolved = true;
  return obj;
};

const resolveGenericObjVersion = (
  type: ObjectType,
  call?: Call
): ObjectType | undefined => {
  if (!call?.typeArgs) return;
  const existing = type.genericInstances?.find((c) => typeArgsMatch(call, c));
  if (existing) return existing;
  return resolveGenericsWithTypeArgs(type, call.typeArgs);
};

const resolveGenericsWithTypeArgs = (
  obj: ObjectType,
  args: List
): ObjectType => {
  const typeParameters = obj.typeParameters!;

  if (args.length !== typeParameters.length) {
    return obj;
  }

  const newObj = obj.clone();
  newObj.typeParameters = undefined;
  newObj.appliedTypeArgs = [];

  /** Register resolved type entities for each type param */
  let typesNotResolved = false;
  typeParameters.forEach((typeParam, index) => {
    const typeArg = args.exprAt(index);
    const identifier = typeParam.clone();
    const type = new TypeAlias({
      name: identifier,
      typeExpr: nop(),
    });
    type.type = getExprType(typeArg);
    if (!type.type) typesNotResolved = true;
    newObj.appliedTypeArgs?.push(type);
    newObj.registerEntity(type);
  });

  if (typesNotResolved) return obj;
  const resolvedObj = resolveObjectTypeTypes(newObj);
  obj.registerGenericInstance(resolvedObj);

  const implementations = newObj.implementations;
  newObj.implementations = []; // Clear implementations to avoid duplicates, resolveImpl will re-add them

  implementations
    .filter((impl) => implIsCompatible(impl, resolvedObj))
    .map((impl) => resolveImpl(impl, resolvedObj));

  return resolvedObj;
};

const typeArgsMatch = (call: Call, candidate: ObjectType): boolean =>
  call.typeArgs && candidate.appliedTypeArgs
    ? candidate.appliedTypeArgs.every((t, i) => {
        const argType = getExprType(call.typeArgs?.at(i));
        const appliedType = getExprType(t);
        return typesAreCompatible(argType, appliedType, {
          exactNominalMatch: true,
        });
      })
    : true;
