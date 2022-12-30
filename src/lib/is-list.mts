import { List, Expr } from "./syntax.mjs";

export const isList = (expr?: Expr): expr is List => expr instanceof List;
