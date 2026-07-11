import {
  type Expr,
  type IdentifierAtom,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { ParserSyntaxError } from "../errors.js";

export type SurfaceCallArgument = {
  syntax: Expr;
  value: Expr;
  label?: IdentifierAtom;
};

const argumentCache = new WeakMap<Expr, SurfaceCallArgument>();

export const parseSurfaceCallArguments = (
  arguments_: readonly Expr[],
): readonly SurfaceCallArgument[] => arguments_.map(parseSurfaceCallArgument);

export const parseSurfaceCallArgument = (expr: Expr): SurfaceCallArgument => {
  const cached = argumentCache.get(expr);
  if (cached) return cached;
  const parsed = parseUncached(expr);
  argumentCache.set(expr, parsed);
  return parsed;
};

const parseUncached = (expr: Expr): SurfaceCallArgument => {
  if (!isForm(expr) || !expr.calls(":")) {
    return { syntax: expr, value: expr };
  }
  const label = expr.at(1);
  const value = expr.at(2);
  if (!isIdentifierAtom(label) || !value || expr.length !== 3) {
    throw new ParserSyntaxError(
      "labeled call argument requires an identifier label and one value",
      expr.location,
    );
  }
  return { syntax: expr, label, value };
};
