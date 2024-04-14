import { Expr } from "../syntax-objects/expr.mjs";

export type TypeChecker = (expr: Expr) => Expr;
