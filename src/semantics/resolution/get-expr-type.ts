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

export const getExprType = (expr?: Expr): Type | undefined => {
  if (!expr) return;
  if (expr.isInt()) return typeof expr.value === "number" ? i32 : i64;
  if (expr.isFloat()) return typeof expr.value === "number" ? f32 : f64;
  if (expr.isBool()) return bool;
  if (expr.isIdentifier()) return getIdentifierType(expr);
  if (expr.isCall()) {
    const resolved = resolveCall(expr);
    return resolved.isCall() ? resolved.type : getExprType(resolved);
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
  // Treat control-flow keywords with meaningful types when used as expressions
  if (id.is("break")) return dVoid;
  if (id.type) return id.type;
  // Value-level `void` placeholder in expression position
  if (id.is("void") && !id.hasTmpAttribute("type-context")) return dVoyd;

  const entity = id.resolve();
  if (!entity && id.is("self") && (id.parentImpl || id.parentTrait)) {
    // When resolving the type of `self` inside a trait, use a scoped
    // `Self` type so that later compatibility checks know which trait the
    // `Self` belongs to. Implementations get their concrete target type.
    id.type = id.parentImpl?.targetType ?? selfType.clone(id);
  }
  if (!entity) return;
  if (entity.isVariable()) return entity.type;
  if (entity.isGlobal()) return entity.type;
  if (entity.isParameter()) return entity.type;
  if (entity.isFn()) return entity.getType();
  if (entity.isClosure()) return entity.getType();
  if (entity.isTypeAlias()) {
    return (
      entity.type ?? (entity.typeExpr?.isType() ? entity.typeExpr : undefined)
    );
  }
  if (entity.isType()) return entity;
  if (entity.isTrait()) return entity;
};
