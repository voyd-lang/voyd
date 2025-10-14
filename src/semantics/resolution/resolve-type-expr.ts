import {
  Call,
  Expr,
  FixedArrayType,
  nop,
  TypeAlias,
  FnType,
  Type,
} from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";
import { resolveIntersectionType } from "./resolve-intersection.js";
import { resolveObjectType } from "./resolve-object-type.js";
import { resolveUnionType } from "./resolve-union.js";
import { resolveTrait } from "./resolve-trait.js";
import { internTypeWithContext } from "../types/type-context.js";

export const resolveTypeExpr = (typeExpr: Expr): Expr => {
  if (typeExpr.isIdentifier()) {
    typeExpr.setTmpAttribute("type-context", true);
    return typeExpr;
  }
  if (typeExpr.isTypeAlias()) {
    if (typeExpr.type || !typeExpr.typeExpr) return typeExpr;
    if (typeExpr.resolutionPhase > 0) return typeExpr;
    typeExpr.resolutionPhase = 1;
    typeExpr.typeExpr = resolveTypeExpr(typeExpr.typeExpr);
    typeExpr.type = getExprType(typeExpr.typeExpr);
    typeExpr.resolutionPhase = 2;
    return typeExpr;
  }
  if (typeExpr.isObjectType()) return resolveObjectType(typeExpr);
  if (typeExpr.isIntersectionType()) return resolveIntersectionType(typeExpr);
  if (typeExpr.isUnionType()) return resolveUnionType(typeExpr);
  if (typeExpr.isFixedArrayType()) return resolveFixedArrayType(typeExpr);
  if (typeExpr.isFnType()) return resolveFnType(typeExpr);
  if (typeExpr.isCall()) return resolveTypeCall(typeExpr);
  return typeExpr;
};

const resolveTypeCall = (call: Call): Call => {
  const finish = (type?: Type, fn?: any) => {
    const canonicalType = internTypeWithContext(type);
    if (fn) call.fn = fn;
    if (canonicalType) call.type = canonicalType;
    call.setTmpAttribute("resolving", undefined);
    return call;
  };

  if (call.hasTmpAttribute("resolving")) return call;
  call.setTmpAttribute("resolving", true);
  const type = call.fnName.resolve();
  if (!type?.isType()) return finish();

  if (call.typeArgs) call.typeArgs = call.typeArgs.map(resolveTypeExpr);

  if (type.isObjectType()) return finish(resolveObjectType(type, call), type);
  if (type.isTraitType()) return finish(resolveTrait(type, call));
  if (type.isFixedArrayType()) return finish(resolveFixedArrayType(type));
  if (type.isUnionType()) return finish(resolveUnionType(type));
  if (type.isIntersectionType()) return finish(resolveIntersectionType(type));
  if (type.isTypeAlias()) {
    resolveTypeAlias(call, type);
    return finish(call.type, call.fn);
  }
  return finish(type);
};

export const resolveFixedArrayType = (arr: FixedArrayType): FixedArrayType => {
  arr.elemTypeExpr = resolveTypeExpr(arr.elemTypeExpr);
  arr.elemType = getExprType(arr.elemTypeExpr);
  arr.setName("FixedArray");
  arr.id = `FixedArray#${arr.elemType?.id}`;
  return internTypeWithContext(arr) as FixedArrayType;
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

  return internTypeWithContext(fnType) as FnType;
};

export const resolveTypeAlias = (call: Call, type: TypeAlias): Call => {
  const alias = type.clone();

  if (alias.typeParameters) {
    alias.typeParameters.forEach((typeParam, index) => {
      const typeArg = call.typeArgs?.exprAt(index);
      const identifier = typeParam.clone();
      const aliasType = new TypeAlias({
        name: identifier,
        typeExpr: nop(),
      });
      aliasType.type = getExprType(typeArg);
      alias.registerEntity(aliasType);
    });
  }

  alias.typeExpr = resolveTypeExpr(alias.typeExpr);
  alias.type = getExprType(alias.typeExpr);
  const canonicalType = internTypeWithContext(alias.type);
  call.type = canonicalType;
  call.fn = canonicalType?.isObjectType() ? canonicalType : undefined;
  return call;
};
