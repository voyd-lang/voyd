import { isFloat } from "../lib/is-float.mjs";
import { isList } from "../lib/is-list.mjs";
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

    const id = ((expr[1] as AST)[0] as string).replace(/\'/g, "");
    macros.set(id, expr);
  }

  return { transformed, macros };
};

/** Recursively expands all macros in the expr */
const expandMacros = (expr: Expr, macros: Macros): Expr => {
  if (!isList(expr)) return expr;

  return expr.reduce((prev: AST, expr) => {
    if (!isList(expr)) {
      prev.push(expr);
      return prev;
    }

    if (typeof expr[0] === "string" && macros.has(expr[0])) {
      const transformed = expandMacro(expr, macros);
      prev.push(...(expandMacros(transformed, macros) as AST));
      return prev;
    }

    prev.push(expandMacros(expr, macros));
    return prev;
  }, []);
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

/** TODO: Support variables here */
const evalMacroBody = (
  body: Expr,
  parameters: Map<string, Expr>,
  macros: Macros
): Expr => {
  if (typeof body === "number") return body;
  if (typeof body === "string" && body.startsWith("$")) {
    return parameters.get(body.slice(1)) ?? [];
  }
  if (typeof body === "string") return body;
  if (typeof body === "boolean") return body;
  return body.reduce((prev: AST, expr) => {
    const fnCall = fnCallSymbol(expr);
    if (fnCall === "$") {
      prev.push(callFn((expr as AST).slice(1), { parameters, macros }));
      return prev;
    }
    if (fnCall === "$@") {
      return [
        ...prev,
        ...(callFn((expr as AST).slice(1), { parameters, macros }) as AST),
      ];
    }
    prev.push(evalMacroBody(expr, parameters, macros));
    return prev;
  }, []);
};

const fnCallSymbol = (expr: Expr): string | undefined => {
  if (!isList(expr)) return;
  const identifier = expr[0];
  if (typeof identifier !== "string") return;
  if (identifier === "$") return "$";
  if (identifier === "$@") return "$@";
  return;
};

type Variable = { value: Expr; mutable: boolean };
type Variables = Map<string, Variable>;
type CallFnOpts = {
  parameters: Map<string, Expr>;
  vars?: Variables;
  macros: Macros;
};

/** TODO: Support scoping */
const callFn = (fn: Expr, { parameters, vars, macros }: CallFnOpts): Expr => {
  if (typeof fn === "string") {
    return vars?.get(fn)?.value ?? parameters.get(fn) ?? fn;
  }

  if (!isList(fn)) return fn;
  const identifier = fn[0];

  if (typeof identifier !== "string") {
    return identifier;
  }

  if (macros.has(identifier)) {
    const transformed = expandMacro(fn, macros);
    return callFn(transformed as AST, { parameters, vars, macros });
  }

  const variables: Variables =
    vars ??
    new Map(
      [...parameters].map(([key, value]) => [key, { value, mutable: false }])
    );

  const shouldSkipArgEval =
    identifier === "if" ||
    identifier === "quote" ||
    identifier === "lambda-expr";

  const args: AST = !shouldSkipArgEval
    ? fn.slice(1).map((expr) => {
        if (expr instanceof Array) {
          return callFn(expr, {
            parameters,
            macros,
            vars: variables,
          });
        }

        if (typeof expr === "number") return expr;
        if (typeof expr === "boolean") return expr;
        if (isString(expr)) return expr.replace(/\"/g, "");
        if (isFloat(expr)) return Number(expr.replace("/float", ""));
        return variables.get(expr)?.value ?? expr;
      })
    : fn.slice(1);

  if (variables.has(identifier)) {
    return callLambda({
      lambda: variables.get(identifier)?.value,
      macros,
      parameters,
      variables,
      args,
    });
  }

  return functions[identifier]({ variables, macros, parameters }, ...args);
};

type CallLambdaOpts = {
  lambda: any;
  args: AST;
  variables: Variables;
  macros: Macros;
  parameters: Map<string, Expr>;
};

const callLambda = (opts: CallLambdaOpts): Expr => {
  const lambda = opts.lambda[1][1];
  const parameters = lambda[0];
  const body = lambda[1];
  const variables = new Map([
    ...opts.variables,
    ["&lambda", { mutable: false, value: opts.lambda }],
    ...(parameters instanceof Array ? parameters : [parameters]).map(
      (p, index): [string, Variable] => [
        p,
        { mutable: false, value: opts.args[index] },
      ]
    ),
  ]);
  const result = body.map((expr: any) =>
    callFn(expr, {
      parameters: opts.parameters,
      macros: opts.macros,
      vars: variables,
    })
  );
  return result[result.length - 1];
};

type FnOpts = {
  variables: Variables;
  macros: Macros;
  parameters: Map<string, Expr>;
};

const functions: Record<string, (opts: FnOpts, ...rest: any[]) => Expr> = {
  extract: (_, list: AST, index: number) => list[index],
  block: (_, ...expressions: Expr[]) => expressions[expressions.length - 1],
  array: (_, ...rest: Expr[]) => rest,
  slice: (_, array: AST, index: number) => array.slice(index),
  length: (_, array: AST) => array.length,
  "define-mut": ({ variables: vars }, id: string, value: Expr) => {
    vars.set(id, { value, mutable: true });
    return value;
  },
  define: ({ variables: vars }, id: string, value: Expr) => {
    vars.set(id, { value, mutable: false });
    return value;
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
  "==": (_, left, right) => left === right,
  ">": (_, left, right) => left > right,
  ">=": (_, left, right) => left >= right,
  "<": (_, left, right) => left < right,
  "<=": (_, left, right) => left <= right,
  and: (_, left, right) => left && right,
  or: (_, left, right) => left || right,
  "+": (_, left, right) => left + right,
  "-": (_, left, right) => left - right,
  "*": (_, left, right) => left * right,
  "/": (_, left, right) => left / right,
  "lambda-expr": (_, lambda) => ["lambda-expr", lambda],
  quote: (_, quote) => quote[0],
  if: (
    { variables, macros, parameters },
    condition: Expr,
    ifTrue: Expr,
    ifFalse: Expr
  ) => {
    const condResult = callFn(handleOptionalConditionParenthesis(condition), {
      vars: variables,
      macros,
      parameters,
    });
    if (condResult) {
      return callFn(ifTrue, { parameters, macros, vars: variables });
    }
    if (ifFalse) {
      return callFn(ifFalse, { parameters, macros, vars: variables });
    }
    return [];
  },
  map: ({ variables, macros, parameters }, array: AST, lambda: AST) => {
    return array.map((val, index, array) =>
      callLambda({
        lambda,
        macros,
        parameters,
        variables,
        args: [val, index, array],
      })
    );
  },
  reduce: (
    { variables, macros, parameters },
    array: AST,
    start: Expr,
    lambda: AST
  ) => {
    return array.reduce(
      (prev, cur, index, array) =>
        callLambda({
          lambda,
          macros,
          parameters,
          variables,
          args: [prev, cur, index, array],
        }),
      start
    );
  },
  push: (_, array: AST, val: Expr) => {
    array.push(val);
    return [];
  },
  concat: (_, ...rest: AST[]) => rest.flat(),
  "is-list": (_, list) => isList(list),
  log: (_, arg) => {
    console.error(JSON.stringify(arg, undefined, 2));
    return arg;
  },
  "macro-expand": ({ macros }, body: AST) => expandMacros(body, macros),
};

const handleOptionalConditionParenthesis = (expr: Expr): Expr => {
  if (isList(expr) && expr.length === 1 && isList(expr[0])) {
    return expr[0];
  }
  return expr;
};
