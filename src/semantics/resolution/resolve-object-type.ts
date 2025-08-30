import { Call } from "../../syntax-objects/call.js";
import { nop } from "../../syntax-objects/lib/helpers.js";
import { List } from "../../syntax-objects/list.js";
import {
  ObjectType,
  TypeAlias,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { inferTypeArgs, TypeArgInferencePair } from "./infer-type-args.js";
import { implIsCompatible, resolveImpl } from "./resolve-impl.js";
import { typesAreEqual } from "./types-are-equal.js";
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

// Detects whether a type-argument expression contains an unresolved type
// identifier (e.g., an unbound generic name like `T`).
const containsUnresolvedTypeId = (expr: any): boolean => {
  const visitExpr = (e: any): boolean => {
    if (!e) return false;
    if (e.isIdentifier && e.isIdentifier()) {
      const entity = e.resolve?.();
      const ty = getExprType(e);
      return !entity && !ty;
    }
    if (e.isCall && e.isCall()) {
      if (e.typeArgs) return e.typeArgs.toArray().some(visitExpr);
      return false;
    }
    if (e.isType && e.isType()) {
      if (e.isObjectType && e.isObjectType()) {
        return e.fields.some((f: any) => visitExpr(f.typeExpr));
      }
      if (e.isIntersectionType && e.isIntersectionType()) {
        return (
          visitExpr(e.nominalTypeExpr?.value) ||
          visitExpr(e.structuralTypeExpr?.value)
        );
      }
      if (e.isFixedArrayType && e.isFixedArrayType()) {
        return visitExpr(e.elemTypeExpr);
      }
      if (e.isFnType && e.isFnType()) {
        return (
          e.parameters.some((p: any) => visitExpr(p.typeExpr)) ||
          (!!e.returnTypeExpr && visitExpr(e.returnTypeExpr))
        );
      }
      return false;
    }
    if (e.isList && e.isList()) return e.toArray().some(visitExpr);
    return false;
  };
  return visitExpr(expr);
};

const resolveGenericObjVersion = (
  type: ObjectType,
  call?: Call
): ObjectType | undefined => {
  if (!call) return;

  // If no explicit type args are supplied, try to infer them from the
  // supplied object literal.
  if (!call.typeArgs) {
    const objLiteral = call.argAt(0);
    if (objLiteral?.isObjectLiteral()) {
      const pairs = type.fields
        .map((field) => {
          const initField = objLiteral.fields.find(
            (f) => f.name === field.name
          );
          return initField
            ? { typeExpr: field.typeExpr, argExpr: initField.initializer }
            : undefined;
        })
        .filter((p): p is TypeArgInferencePair => !!p);
      call.typeArgs = inferTypeArgs(type.typeParameters, pairs);
    }
  }

  if (!call.typeArgs) return;

  const hasUnresolved = call.typeArgs
    .toArray()
    .some((arg) => containsUnresolvedTypeId(arg));
  if (hasUnresolved) return;

  // THAR BE DRAGONS HERE. We don't check for multiple existing matches, which means that unions may sometimes overlap.
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
  newObj.genericParent = obj;

  /** Register resolved type entities for each type param */
  let typesNotResolved = false;
  typeParameters.forEach((typeParam, index) => {
    const typeArg = args.exprAt(index);
    const identifier = typeParam.clone();
    const type = new TypeAlias({
      name: identifier,
      // Preserve the original type arg expression (e.g., MsgPack) for
      // readable formatting of applied generics without expanding recursively.
      typeExpr: typeArg.clone(),
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
        return typesAreEqual(argType, appliedType);
      })
    : true;
