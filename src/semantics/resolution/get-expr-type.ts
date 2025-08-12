import { Expr } from "../../syntax-objects/expr.js";
import { Identifier } from "../../syntax-objects/index.js";
import {
  Type,
  i32,
  f32,
  bool,
  i64,
  f64,
  voydString,
} from "../../syntax-objects/types.js";
import { resolveCall } from "./resolve-call.js";

export const getExprType = (expr?: Expr): Type | undefined => {
  if (!expr) return;
  if (expr.isInt()) return typeof expr.value === "number" ? i32 : i64;
  if (expr.isFloat()) return typeof expr.value === "number" ? f32 : f64;
  if (expr.isStringLiteral()) return voydString;
  if (expr.isBool()) return bool;
  if (expr.isIdentifier()) return getIdentifierType(expr);
  if (expr.isCall()) return resolveCall(expr)?.type;
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
  const entity = id.resolve();
  if (!entity) return;
  if (entity.isVariable()) return entity.type;
  if (entity.isGlobal()) return entity.type;
  if (entity.isParameter()) return entity.type;
  if (entity.isFn()) return entity.getType();
  if (entity.isTypeAlias()) return entity.type;
  if (entity.isType()) return entity;
  if (entity.isTrait()) return entity;
};
