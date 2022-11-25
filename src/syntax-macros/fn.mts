import { isList } from "../lib/is-list.mjs";
import { AST } from "../parser.mjs";

/** Converts fn syntax full function definition (define-function). TODO: Move to normal macro */
export const fn = (ast: AST): AST => {
  return ast.map((expr) => {
    if (!isList(expr)) return expr;
    if (expr[0] !== "fn" && expr[0] !== "defun") return fn(expr);

    const definitions = expr[1];

    if (!(definitions instanceof Array)) {
      throw new Error("Missing definitions from fn");
    }

    const identifier = definitions[0];

    const params = [
      "parameters",
      ...definitions.slice(1).map((expr) => {
        if (!isList(expr)) {
          throw new Error(`Expected list, got ${expr}`);
        }

        const noLabel = expr.length === 3;
        const identifier = noLabel ? expr[1] : expr[2];
        const type = noLabel ? expr[2] : expr[3];
        return [identifier, type];
      }),
    ];

    const typeArrowIndex =
      expr[2] === "->" ? 2 : expr[3] === "->" ? 3 : undefined;

    const returnType = [
      "return-type",
      typeArrowIndex ? expr[typeArrowIndex + 1] : [],
    ];

    const expressions = typeArrowIndex
      ? expr.slice(typeArrowIndex + 2)
      : expr.slice(2);

    const variables = ["variables", ...findVariables(expressions)];

    return [
      "define-function",
      identifier,
      params,
      variables,
      returnType,
      ["block", ...expressions],
    ];
  });
};

const findVariables = (fnBody: AST): AST => {
  return fnBody.reduce((vars: AST, expr) => {
    if (!(expr instanceof Array)) return vars;

    if (expr[0] === "define-let") {
      vars.push([expr[1], expr[2]]);
      return vars;
    }

    vars.push(...findVariables(expr));
    return vars;
  }, []);
};
