import { Expr, isList } from "../../../lib/index.mjs";

export const isStruct = (expr?: Expr) => isList(expr) && expr.calls("struct");
