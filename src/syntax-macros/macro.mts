import { isFloat } from "../lib/is-float.mjs";
import { isString } from "../lib/is-string.mjs";
import { ModuleInfo } from "../lib/module-info.mjs";
import { AST, Expr } from "../parser.mjs";

/** TODO: Support scoping */
type Macros = Map<string, AST>;

/** Transforms macro's into their final form and then runs them */
export const macro = (ast: AST, info: ModuleInfo): AST => {
  if (!info.isRoot) return ast;
  const { macros, transformed } = registerMacros(ast);
  return expandMacros(transformed, macros) as AST;
};

/** Registers macros and removes them. For now we cheat and interpret `macro` directly rather than transforming it */
const registerMacros = (ast: AST): { transformed: AST; macros: Macros } => {
  let macros: Macros = new Map();
  const transformed: AST = [];

  for (const expr of ast) {
    if (!(expr instanceof Array)) {
      transformed.push(expr);
      continue;
    }

    if (expr[0] !== "macro") {
      const sub = registerMacros(expr);
      macros = new Map([...macros, ...sub.macros]);
      transformed.push(sub.transformed);
      continue;
    }

    macros.set((expr[1] as AST)[0] as string, expr);
  }

  return { transformed, macros };
};

/** Recursively expands all macros in the expr */
const expandMacros = (expr: Expr, macros: Macros): Expr => {
  if (!(expr instanceof Array)) return expr;

  if (typeof expr[0] === "string" && macros.has(expr[0])) {
    const transformed = expandMacro(expr, macros);
    return expandMacros(transformed, macros);
  }

  return expr.map((expr) => expandMacros(expr, macros));
};

/** Expands a macro call. Assumes expr is a macro call */
const expandMacro = (expr: AST, macros: Macros): Expr => {
  const macro = macros.get(expr[0] as string);
  if (!macro) return expr;
  const parameters = mapMacroParameters(expr, (macro[1] as string[]).slice(1));
  parameters.set("&body", expr.slice(1));
  return evalMacroBody(macro.slice(2), parameters);
};

const mapMacroParameters = (callExpr: AST, parameters: string[]) =>
  parameters.reduce((map, name, index) => {
    const arg = callExpr[index + 1];
    map.set(name, arg);
    return map;
  }, new Map<string, Expr>());

const evalMacroBody = (body: Expr, parameters: Map<string, Expr>): Expr => {
  if (typeof body === "number") return body;
  if (typeof body === "string" && body[0] === "$" && body.length > 1) {
    return parameters.get(body.slice(1)) ?? [];
  }
  if (typeof body === "string") return body;
  if (body[0] === "$") return callFn(body.slice(1), parameters);
  return body.map((expr) => evalMacroBody(expr, parameters));
};

const callFn = (fn: AST, parameters: Map<string, Expr>) => {
  const identifier = fn[0];
  const args: AST = fn.slice(1).map((expr) => {
    if (expr instanceof Array) return callFn(expr, parameters);
    if (typeof expr === "number") return expr;
    if (isString(expr) || isFloat(expr)) return expr;
    return parameters.get(expr);
  });
  return functions[identifier as string](...args);
};

const functions: any = {
  extract: (list: Array<any>, index: number) => list[index],
};
