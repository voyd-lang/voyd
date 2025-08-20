import { Call } from "../../syntax-objects/call.js";
import { nop } from "../../syntax-objects/lib/helpers.js";
import { List } from "../../syntax-objects/list.js";
import {
  ObjectType,
  Type,
  TypeAlias,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { implIsCompatible, resolveImpl } from "./resolve-impl.js";
import { typesAreCompatible } from "./types-are-compatible.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";

export const resolveObjectType = (obj: ObjectType, call?: Call): ObjectType => {
  if (obj.typesResolved) return obj;

  if (obj.typeParameters) {
    return resolveGenericObjVersion(obj, call) ?? obj;
  }

  obj.fields.forEach((field) => {
    field.typeExpr = resolveTypeExpr(field.typeExpr);
    field.type = getExprType(field.typeExpr);
  });

  if (obj.parentObjExpr) {
    obj.parentObjExpr = resolveTypeExpr(obj.parentObjExpr);
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
  if (!call) return;

  // If no explicit type args are supplied, try to infer them from the
  // supplied object literal.
  if (!call.typeArgs) {
    call.typeArgs = inferObjectInitTypeArgs(type, call);
  }

  if (!call.typeArgs) return;

  const existing = type.genericInstances?.find((c) => typeArgsMatch(call, c));
  if (existing) return existing;
  return resolveGenericsWithTypeArgs(type, call.typeArgs);
};

/** Attempt to infer type arguments for a generic object type from the
 *  initialization call's object literal. */
const inferObjectInitTypeArgs = (type: ObjectType, call: Call): List | undefined => {
  const typeParams = type.typeParameters;
  if (!typeParams?.length) return;

  const objLiteral = call.argAt(0);
  if (!objLiteral || !objLiteral.isObjectLiteral()) return;

  const inferred: Type[] = [];

  for (const tp of typeParams) {
    let inferredType: Type | undefined;
    // Find a field in the object type that references this type parameter
    for (const field of type.fields) {
      if (field.typeExpr.isIdentifier() && field.typeExpr.is(tp)) {
        const initField = objLiteral.fields.find((f) => f.name === field.name);
        inferredType = initField?.type;
        break;
      }
    }

    if (!inferredType) {
      // Unable to infer all type parameters
      return undefined;
    }

    inferred.push(inferredType);
  }

  return new List({ value: inferred });
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
  newObj.genericParent = obj;

  /** Register resolved type entities for each type param */
  let typesNotResolved = false;
  typeParameters.forEach((typeParam, index) => {
    const typeArg = args.exprAt(index);
    const identifier = typeParam.clone();
    const type = new TypeAlias({
      name: identifier,
      typeExpr: nop(),
    });
    resolveTypeExpr(typeArg);
    type.type = getExprType(typeArg);
    if (!type.type) typesNotResolved = true;
    newObj.appliedTypeArgs?.push(type);
    newObj.registerEntity(type);
  });

  if (typesNotResolved) return obj;
  obj.registerGenericInstance(newObj);
  const resolvedObj = resolveObjectType(newObj);

  newObj.implementations
    ?.filter((impl) => implIsCompatible(impl, resolvedObj))
    .forEach((impl) => resolveImpl(impl, resolvedObj));

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
