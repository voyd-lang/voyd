import { AST, Expr } from "../parser.mjs";

type Macros = Map<string, AST>;

/** Transforms macro's into their final form and then runs them */
export const macro = (ast: AST): AST => {
  const { macros, transformed } = registerMacros(ast);
  return expandMacros(transformed, macros) as AST;
};

/** Registers macros and removes them. For now we cheat and interpret `macro` directly rather than transforming it */
const registerMacros = (ast: AST): { transformed: AST; macros: Macros } => {
  const macros: Macros = new Map();
  const transformed: AST = [];

  for (const expr of ast) {
    if (!(expr instanceof Array) || expr[0] !== "macro") {
      transformed.push(expr);
      continue;
    }

    macros.set((expr[1] as AST)[0] as string, expr);
  }

  return { transformed, macros };
};

/** Recursively expands all macros in the expr */
const expandMacros = (expr: Expr, macros: Macros): Expr => {
  if (!(expr instanceof Array)) return expr;

  const transformed = expr.map((exp) => expandMacros(exp, macros));

  if (typeof transformed[0] === "string" && macros.has(transformed[0])) {
    return expandMacro(transformed, macros);
  }

  return transformed;
};

/** Expands a macro call. Assumes expr is a macro call */
const expandMacro = (expr: AST, macros: Macros): Expr => {
  const macro = macros.get(expr[0] as string);
  if (!macro) return expr;
  const parameters = mapMacroParameters(expr, (macro[1] as string[]).slice(1));
  return evalMacroBody(macro[2], parameters);
};

const mapMacroParameters = (callExpr: AST, parameters: string[]) =>
  parameters.reduce((map, name, index) => {
    const arg = callExpr[index + 1];
    map.set(name, arg);
    return map;
  }, new Map<string, Expr>());

const evalMacroBody = (body: Expr, parameters: Map<string, Expr>): Expr => {
  if (typeof body === "number") return body;
  if (typeof body === "string" && body[0] === "$") {
    return parameters.get(body.slice(1)) ?? [];
  }
  if (typeof body === "string") return body;
  return body.map((expr) => evalMacroBody(expr, parameters));
};
