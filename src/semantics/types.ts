import { Expr } from "../syntax-objects/expr.js";

export type TypeChecker = (expr: Expr) => Expr;
