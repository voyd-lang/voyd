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
  return evalMacroBody(macro.slice(2), parameters, macros);
};

const mapMacroParameters = (callExpr: AST, parameters: string[]) =>
  parameters.reduce((map, name, index) => {
    const arg = callExpr[index + 1];
    map.set(name, arg);
    return map;
  }, new Map<string, Expr>());

const evalMacroBody = (
  body: Expr,
  parameters: Map<string, Expr>,
  macros: Macros
): Expr => {
  if (typeof body === "number") return body;
  if (typeof body === "string" && body[0] === "$" && body.length > 1) {
    return parameters.get(body.slice(1)) ?? [];
  }
  if (typeof body === "string") return body;
  if (body[0] === "$") return callFn(body.slice(1), { parameters, macros });
  return body.map((expr) => evalMacroBody(expr, parameters, macros));
};

type Variable = { value: Expr; mutable: boolean };
type Variables = Map<string, Variable>;
type CallFnOpts = {
  parameters: Map<string, Expr>;
  vars?: Variables;
  macros: Macros;
};

const callFn = (fn: AST, { parameters, vars, macros }: CallFnOpts): Expr => {
  const identifier = fn[0] as string;

  if (identifier === "quote") return fn.slice(1);

  if (macros.has(identifier)) {
    const transformed = expandMacro(fn, macros);
    return callFn(transformed as AST, { parameters, vars, macros });
  }

  const variables: Variables =
    vars ??
    new Map(
      [...parameters].map(([key, value]) => [key, { value, mutable: false }])
    );

  const args: AST = fn.slice(1).map((expr) => {
    if (expr instanceof Array) {
      return callFn(expr, {
        parameters,
        macros,
        vars: new Map([...variables]),
      });
    }

    if (typeof expr === "number") return expr;
    if (isString(expr) || isFloat(expr)) return expr;
    return parameters.get(expr)!;
  });

  return functions[identifier]({ variables, macros }, ...args);
};

type FnOpts = {
  variables: Variables;
  macros: Macros;
};

const functions: Record<string, (opts: FnOpts, ...rest: any[]) => Expr> = {
  extract: (_, list: AST, index: number) => list[index],
  block: (_, ...expressions: Expr[]) => expressions[expressions.length - 1],
  array: (_, ...rest: Expr[]) => rest,
  "define-mut": ({ variables: vars }, assignment: any[]) => {
    vars.set(assignment[0], { value: assignment[1], mutable: true });
    return [];
  },
  define: ({ variables: vars }, assignment: any[]) => {
    vars.set(assignment[0], { value: assignment[1], mutable: false });
    return [];
  },
  "=": ({ variables: vars }, identifier, expr) => {
    const variable = vars.get(identifier);
    if (!variable) throw new Error(`identifier not found ${identifier}`);
    if (!variable.mutable) {
      throw new Error(`Variable ${identifier} is not mutable`);
    }
    vars.set(identifier, expr);
    return [];
  },
  "lambda-expr": ({ variables: vars, macros }, quote: AST) => {
    const variables: Variables = new Map([
      ...vars,
      ["&lambda", { value: ["lambda-expr", quote], mutable: false }],
    ]);
    return callFn();
  },
};
