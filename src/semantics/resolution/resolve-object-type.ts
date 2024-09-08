import { Call } from "../../syntax-objects/call.js";
import { List } from "../../syntax-objects/list.js";
import {
  ObjectType,
  TypeAlias,
  voidBaseObject,
} from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypes } from "./resolve-types.js";
import { typesAreEquivalent } from "./types-are-equivalent.js";

export const resolveObjectTypeTypes = (
  obj: ObjectType,
  call?: Call
): ObjectType => {
  if (obj.typeParameters && call) {
    return resolveGenericObjVersion(call, obj) ?? obj;
  }

  obj.fields.forEach((field) => {
    field.typeExpr = resolveTypes(field.typeExpr);
    field.type = getExprType(field.typeExpr);
  });

  if (obj.parentObjExpr) {
    const parentType = getExprType(obj.parentObjExpr);
    obj.parentObj = parentType?.isObjectType() ? parentType : undefined;
  } else {
    obj.parentObj = voidBaseObject;
  }

  return obj;
};

const resolveGenericObjVersion = (
  call: Call,
  type: ObjectType
): ObjectType | undefined => {
  const existing = type.genericInstances?.find((c) => typeArgsMatch(call, c));
  if (existing) return existing;
  return resolveGenericsWithTypeArgs(type, call.typeArgs!);
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
  newObj.id = obj.id + `#${obj.genericInstances?.length ?? 0}`;
  newObj.typeParameters = undefined;
  newObj.appliedTypeArgs = [];

  /** Register resolved type entities for each type param */
  typeParameters.forEach((typeParam, index) => {
    const typeArg = args.exprAt(index);
    const identifier = typeParam.clone();
    const type = new TypeAlias({
      name: identifier,
      typeExpr: typeArg,
    });
    type.type = getExprType(typeArg);
    newObj.appliedTypeArgs?.push(type);
    newObj.registerEntity(type);
  });

  const resolvedFn = resolveObjectTypeTypes(newObj);
  obj.registerGenericInstance(resolvedFn);
  return obj;
};

const typeArgsMatch = (call: Call, candidate: ObjectType): boolean =>
  call.typeArgs && candidate.appliedTypeArgs
    ? candidate.appliedTypeArgs.every((t, i) => {
        const argType = getExprType(call.typeArgs?.at(i));
        const appliedType = getExprType(t);
        return typesAreEquivalent(argType, appliedType);
      })
    : true;
