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
} from "../../syntax-objects/types.js";
import { resolveCall } from "./resolve-call.js";

export const getExprType = (expr?: Expr): Type | undefined => {
  if (!expr) return;
  if (expr.isInt()) return typeof expr.value === "number" ? i32 : i64;
  if (expr.isFloat()) return typeof expr.value === "number" ? f32 : f64;
  if (expr.isBool()) return bool;
  if (expr.isIdentifier()) return getIdentifierType(expr);
  if (expr.isCall()) {
    const resolved = resolveCall(expr);
    let type = resolved?.type;
    if (expr.hasAttribute("mutable") && type && !type.hasAttribute("mutable")) {
      type = type.clone(expr);
      type.setAttribute("mutable", true);
      if (resolved) resolved.type = type;
    }
    return type;
  }
  if (expr.isFn()) return expr.getType();
  if (expr.isClosure()) return expr.getType();
  if (expr.isTypeAlias()) return expr.type;
  if (expr.isType()) return expr;
  if (expr.isBlock()) return expr.type;
  if (expr.isObjectLiteral()) return expr.type;
  if (expr.isMatch()) return expr.type;
  if (expr.isUnionType()) return expr;
};

export const getIdentifierType = (id: Identifier): Type | undefined => {
  if (id.type) return id.type;
  const entity = id.resolve();
  if (!entity && id.is("self") && (id.parentImpl || id.parentTrait)) {
    // When resolving the type of `self` inside a trait, use a scoped
    // `Self` type so that later compatibility checks know which trait the
    // `Self` belongs to. Implementations get their concrete target type.
    id.type = id.parentImpl?.targetType ?? selfType.clone(id);
  }
  if (!entity) return;
  if (entity.isVariable() || entity.isGlobal() || entity.isParameter()) {
    const type = entity.type;
    if (id.hasAttribute("mutable") && !type?.hasAttribute("mutable")) {
      throw new Error(`${id} is not mutable at ${id.location}`);
    }
    return type;
  }
  if (entity.isFn()) return entity.getType();
  if (entity.isClosure()) return entity.getType();
  if (entity.isTypeAlias()) {
    return (
      entity.type ?? (entity.typeExpr?.isType() ? entity.typeExpr : undefined)
    );
  }
  if (entity.isType()) {
    let type: Type = entity;
    if (id.hasAttribute("mutable")) {
      type = type.clone(id);
      type.setAttribute("mutable", true);
    }
    return type;
  }
  if (entity.isTrait()) return entity;
};
