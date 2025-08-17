import {
  Call,
  Expr,
  FixedArrayType,
  nop,
  TypeAlias,
  FnType,
} from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";
import { resolveIntersectionType } from "./resolve-intersection.js";
import { resolveObjectType } from "./resolve-object-type.js";
import { resolveUnionType } from "./resolve-union.js";
import { resolveTrait } from "./resolve-trait.js";

export const resolveTypeExpr = (typeExpr: Expr): Expr => {
  if (typeExpr.isIdentifier()) return typeExpr;
  if (typeExpr.isObjectType()) return resolveObjectType(typeExpr);
  if (typeExpr.isIntersectionType()) return resolveIntersectionType(typeExpr);
  if (typeExpr.isUnionType()) return resolveUnionType(typeExpr);
  if (typeExpr.isFixedArrayType()) return resolveFixedArrayType(typeExpr);
  if (typeExpr.isFnType()) return resolveFnType(typeExpr);
  if (typeExpr.isCall()) return resolveTypeCall(typeExpr);
  return typeExpr;
};

/** Resolves type calls */
const resolveTypeCall = (call: Call): Call => {
  const type = call.fnName.resolve();

  if (!type?.isType()) return call;

  if (call.typeArgs) {
    call.typeArgs = call.typeArgs.map(resolveTypeExpr);
  }

  if (type.isObjectType()) {
    call.fn = type;
    call.type = resolveObjectType(type, call);
    return call;
  }

  if (type.isTraitType()) {
    call.type = resolveTrait(type, call);
    return call;
  }

  if (type.isFixedArrayType()) {
    call.type = resolveFixedArrayType(type);
    return call;
  }

  if (type.isUnionType()) {
    call.type = resolveUnionType(type);
    return call;
  }

  if (type.isIntersectionType()) {
    call.type = resolveIntersectionType(type);
    return call;
  }

  if (type.isTypeAlias()) {
    call = resolveTypeAlias(call, type);
    return call;
  }

  call.type = type;

  return call;
};

const resolveFixedArrayType = (arr: FixedArrayType): FixedArrayType => {
  arr.elemTypeExpr = resolveTypeExpr(arr.elemTypeExpr);
  arr.elemType = getExprType(arr.elemTypeExpr);
  arr.id = `${arr.id}#${arr.elemType?.id}`;
  return arr;
};

const resolveFnType = (fnType: FnType): FnType => {
  fnType.parameters.forEach((p) => {
    if (p.typeExpr) {
      p.typeExpr = resolveTypeExpr(p.typeExpr);
      p.type = getExprType(p.typeExpr);
    }
  });

  if (fnType.returnTypeExpr) {
    fnType.returnTypeExpr = resolveTypeExpr(fnType.returnTypeExpr);
    const type = getExprType(fnType.returnTypeExpr);
    if (type) fnType.returnType = type;
  }

  return fnType;
};

export const resolveTypeAlias = (call: Call, type: TypeAlias): Call => {
  const alias = type.clone();

  if (alias.typeParameters) {
    alias.typeParameters.forEach((typeParam, index) => {
      const typeArg = call.typeArgs?.exprAt(index);
      const identifier = typeParam.clone();
      const type = new TypeAlias({
        name: identifier,
        typeExpr: nop(),
      });
      type.type = getExprType(typeArg);
      alias.registerEntity(type);
    });
  }

  alias.typeExpr = resolveTypeExpr(alias.typeExpr);
  alias.type = getExprType(alias.typeExpr);
  call.type = alias.type;
  call.fn = call.type?.isObjectType() ? call.type : undefined;
  return call;
};
