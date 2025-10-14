import { Expr } from "../../syntax-objects/expr.js";
import { Identifier } from "../../syntax-objects/index.js";
import {
  Type,
  i32,
  f32,
  bool,
  i64,
  f64,
  selfType,
  dVoid,
  dVoyd,
} from "../../syntax-objects/types.js";
import { resolveCall } from "./resolve-call.js";
import { internTypeWithContext } from "../types/type-context.js";

export const getExprType = (expr?: Expr): Type | undefined => {
  if (!expr) return undefined;

  let type: Type | undefined;

  if (expr.isInt()) {
    type = typeof expr.value === "number" ? i32 : i64;
  } else if (expr.isFloat()) {
    type = typeof expr.value === "number" ? f32 : f64;
  } else if (expr.isBool()) {
    type = bool;
  } else if (expr.isIdentifier()) {
    type = getIdentifierType(expr);
  } else if (expr.isCall()) {
    const resolved = resolveCall(expr);
    type = resolved.isCall() ? resolved.type : getExprType(resolved);
  } else if (expr.isFn()) {
    type = expr.getType();
  } else if (expr.isClosure()) {
    type = expr.getType();
  } else if (expr.isTypeAlias()) {
    type = expr.type;
  } else if (expr.isType()) {
    type = expr;
  } else if (expr.isBlock()) {
    type = expr.type;
  } else if (expr.isObjectLiteral()) {
    type = expr.type;
  } else if (expr.isMatch()) {
    type = expr.type;
  } else if (expr.isUnionType()) {
    type = expr;
  }

  return internTypeWithContext(type);
};

export const getIdentifierType = (id: Identifier): Type | undefined => {
  if (id.is("break")) return internTypeWithContext(dVoid);
  if (id.type) return internTypeWithContext(id.type);
  if (id.is("void") && !id.hasTmpAttribute("type-context")) {
    return internTypeWithContext(dVoyd);
  }

  const entity = id.resolve();
  if (!entity && id.is("self") && (id.parentImpl || id.parentTrait)) {
    id.type = id.parentImpl?.targetType ?? selfType.clone(id);
  }
  if (!entity) return internTypeWithContext(id.type);
  if (entity.isVariable()) return internTypeWithContext(entity.type);
  if (entity.isGlobal()) return internTypeWithContext(entity.type);
  if (entity.isParameter()) return internTypeWithContext(entity.type);
  if (entity.isFn()) return internTypeWithContext(entity.getType());
  if (entity.isClosure()) return internTypeWithContext(entity.getType());
  if (entity.isTypeAlias()) {
    const aliasType =
      entity.type ?? (entity.typeExpr?.isType() ? entity.typeExpr : undefined);
    return internTypeWithContext(aliasType);
  }
  if (entity.isType()) return internTypeWithContext(entity);
  if (entity.isTrait()) return internTypeWithContext(entity);
};
