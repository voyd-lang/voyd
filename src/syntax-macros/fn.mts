import { AST, Expr } from "../parser.mjs";

/** Converts fn syntax full function definition (defun). TODO: Move to normal macro */
export const fn = (ast: AST): AST => {
  return ast.map((expr, index, array) => {
    if (typeof expr === "string") return expr;
    if (expr[0] !== "fn") return fn(expr);

    const definitions = expr[1];

    if (!(definitions instanceof Array)) {
      throw new Error("Missing definitions from fn");
    }

    const identifier = definitions[0];
    const params = [
      "parameters",
      definitions.slice(1).map((expr) => {
        const noLabel = expr.length === 3;
        const identifier = noLabel ? expr[1] : expr[2];
        const type = noLabel ? expr[2] : expr[3];
        const label = noLabel ? [] : expr[1];
        return ["parameter", identifier, type, label];
      }),
    ];

    const typeArrowIndex =
      expr[2] === "->" ? 2 : expr[3] === "->" ? 3 : undefined;

    const effects = [
      "effects",
      ...(typeArrowIndex === 3
        ? []
        : typeof expr[2] === "string"
        ? [expr[2]]
        : expr[2]),
    ];

    const returnType =
      expr[2] === "->"
        ? expr[3]
        : toType(expr[3]) === "->"
        ? toType(expr[4])
        : [];

    return ["defun", identifier, params, effects, returnType];
  });
};

const toType = (expr: Expr): Expr => {
  if (typeof expr === "string") return ["type", expr];
  return ["type", expr[0], ...expr.slice(1).map(toType)];
};

const toEffect = (expr: Expr): Expr => {
  if (typeof expr === "string") return ["effect", expr];
};
