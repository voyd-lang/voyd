import { Call } from "../../syntax-objects/call.js";
import { nop } from "../../syntax-objects/lib/helpers.js";
import { List } from "../../syntax-objects/list.js";
import { ObjectType, Type, TypeAlias } from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { implIsCompatible, resolveImpl } from "./resolve-impl.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { typesAreCompatible } from "./types-are-compatible.js";

export const resolveGenericObjVersion = (
  type: ObjectType,
  call?: Call
): ObjectType | undefined => {
  if (!call) return undefined;

  // If no explicit type args are supplied, try to infer them from the
  // supplied object literal.
  if (!call.typeArgs) {
    call.typeArgs = inferObjectInitTypeArgs(type, call);
  }

  if (!call.typeArgs) return undefined;

  const existing = type.genericInstances?.find((c) => typeArgsMatch(call, c));
  if (existing) return existing;
  return resolveGenericsWithTypeArgs(type, call.typeArgs);
};

/** Attempt to infer type arguments for a generic object type from the
 *  initialization call's object literal. */
const inferObjectInitTypeArgs = (
  type: ObjectType,
  call: Call
): List | undefined => {
  const typeParams = type.typeParameters;
  if (!typeParams?.length) return undefined;

  const objLiteral = call.argAt(0);
  if (!objLiteral || !objLiteral.isObjectLiteral()) return undefined;

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
    const resolvedArg = resolveTypeExpr(typeArg);
    args.set(index, resolvedArg);
    const resolvedType = getExprType(resolvedArg);
    type.type = resolvedType;
    if (!resolvedType) typesNotResolved = true;
    newObj.appliedTypeArgs?.push(type);
    newObj.registerEntity(type);

    // Pre-populate fields referencing this type parameter
    newObj.fields.forEach((field) => {
      if (field.typeExpr.isIdentifier() && field.typeExpr.is(typeParam)) {
        field.type = resolvedType;
      }
    });
  });

  if (typesNotResolved) return obj;

  newObj.fields.forEach((field) => {
    field.typeExpr = resolveTypeExpr(field.typeExpr);
    field.type = getExprType(field.typeExpr);
  });

  if (newObj.parentObjExpr) {
    newObj.parentObjExpr = resolveTypeExpr(newObj.parentObjExpr);
    const parentType = getExprType(newObj.parentObjExpr);
    newObj.parentObjType = parentType?.isObjectType() ? parentType : undefined;
  }

  newObj.typesResolved = true;
  obj.registerGenericInstance(newObj);

  const implementations = newObj.implementations;
  newObj.implementations = []; // Clear implementations to avoid duplicates

  implementations
    .filter((impl) => implIsCompatible(impl, newObj))
    .map((impl) => resolveImpl(impl, newObj));

  return newObj;
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
