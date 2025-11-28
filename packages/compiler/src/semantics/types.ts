import { Expr } from "../syntax-objects/expr.js";

export type SemanticProcessor = (expr: Expr) => Expr;
