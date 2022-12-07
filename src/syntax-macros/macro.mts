import { isFloat } from "../lib/is-float.mjs";
import { isList } from "../lib/is-list.mjs";
import { isStringLiteral } from "../lib/is-string.mjs";
import { ModuleInfo } from "../lib/module-info.mjs";
import { toIdentifier } from "../lib/to-identifier.mjs";
import { AST, Expr } from "../parser.mjs";

/** TODO: Support macro scoping / module import checking */
type Macros = Map<string, AST>;
type Variable = { value: Expr; mutable: boolean };
type Variables = Map<string, Variable>;

/** Transforms macro's into their final form and then runs them */
export const macro = (ast: AST, info: ModuleInfo): AST => {
  if (!info.isRoot) return ast;
  const macros: Macros = new Map();
  const vars: Variables = new Map();
  return evalExpr(ast, { macros, vars }) as AST;
};

type EvalExprOpts = {
  vars: Variables;
  macros: Macros;
};

const evalExpr = (expr: Expr, { vars, macros }: EvalExprOpts) => {
  if (isFloat(expr)) return Number(expr.replace("/float", ""));
  if (isStringLiteral(expr)) return expr.replace(/\"/g, "");
  if (typeof expr === "string") {
    return vars?.get(toIdentifier(expr))?.value ?? expr;
  }
  if (!isList(expr)) return expr;

  return evalFnCall(expr, { vars, macros });
};

const evalFnCall = (ast: AST, { vars, macros }: EvalExprOpts): Expr => {
  if (typeof ast[0] !== "string") {
    return ast;
  }

  const identifier = toIdentifier(ast[0]);

  const shouldSkipArgEval = fnsToSkipArgEval.has(identifier);

  const args: AST = !shouldSkipArgEval
    ? ast.slice(1).map((exp) => evalExpr(exp, { vars, macros }))
    : ast.slice(1);

  const variable = vars?.get(identifier)?.value;
  if (variable && isLambda(variable)) {
    return callLambda({
      lambda: variable,
      macros,
      vars,
      args,
    });
  }

  if (!functions[identifier]) {
    return ast;
  }

  return functions[identifier]({ vars, macros }, ...args);
};

const expandMacros = (ast: Expr, macros: Macros, vars: Variables): Expr => {
  if (!isList(ast)) return ast;
  if (typeof ast[0] === "string") {
    const macro = macros.get(toIdentifier(ast[0]));
    if (macro) return expandMacro({ macro, call: ast, macros, vars });
  }

  return ast.reduce((newAst: AST, expr) => {
    if (!isList(expr)) {
      newAst.push(expr);
      return newAst;
    }

    if (typeof expr[0] !== "string") {
      newAst.push(expandMacros(expr, macros, vars));
      return newAst;
    }

    const identifier = toIdentifier(expr[0]);
    const macro = macros.get(identifier);
    if (!macro) {
      newAst.push(expandMacros(expr, macros, vars));
      return newAst;
    }

    const result = expandMacro({ macro, call: expr, macros, vars });
    isList(result) && result[0] === "splice-block"
      ? newAst.push(...result.slice(1))
      : newAst.push(result);
    return newAst;
  }, []);
};

/** Expands a macro call */
const expandMacro = ({
  macro,
  call,
  macros,
  vars,
}: {
  macro: AST;
  call: AST;
  macros: Macros;
  vars: Variables;
}): Expr => {
  const variables: Variables = new Map([
    ...vars,
    ...mapMacroParameters(call, (macro[0] as string[]).slice(1)),
  ]);
  variables.set("&body", { value: call.slice(1), mutable: false });
  const result = macro
    .slice(1)
    .map((exp) => evalExpr(exp, { macros, vars: variables }));
  return expandMacros(result.pop()!, macros, vars) ?? [];
};

const mapMacroParameters = (callExpr: AST, parameters: string[]) =>
  parameters.reduce((vars: Variables, name, index) => {
    const value = callExpr[index + 1];
    vars.set(name, { value, mutable: false });
    return vars;
  }, new Map());

type CallLambdaOpts = {
  lambda: any;
  args: AST;
  vars: Variables;
  macros: Macros;
};

const callLambda = (opts: CallLambdaOpts): AST => {
  const lambda = opts.lambda.slice(1);
  const parameters = lambda[0];
  const body = lambda.slice(1);
  const vars: Variables = new Map([
    ...opts.vars,
    ["&lambda", { mutable: false, value: opts.lambda }],
    ...parameters.map((p: any, index: number): [string, Variable] => [
      p,
      { mutable: false, value: opts.args[index] },
    ]),
  ]);

  const result = body.map((expr: any) =>
    evalExpr(expr, { macros: opts.macros, vars })
  );
  return result[result.length - 1];
};

type FnOpts = {
  vars: Variables;
  macros: Macros;
};

const functions: Record<string, (opts: FnOpts, ...rest: any[]) => Expr> = {
  macro: ({ macros, vars }, ...macro: AST) => {
    registerMacro(macros, expandMacros(macro, macros, vars) as AST);
    return ["splice-block"];
  },
  root: ({ vars, macros }, ...root: AST) => {
    root.unshift("root");
    return root.map((module) => {
      if (!isList(module)) return module;
      module[4] = (module[4] as AST).reduce((body: AST, expr) => {
        if (!isList(expr)) {
          body.push(evalExpr(expr, { vars, macros }));
          return body;
        }

        const transformed = evalExpr(expandMacros(expr, macros, vars), {
          vars,
          macros,
        });

        if (!isList(transformed)) {
          body.push(transformed);
          return body;
        }

        transformed[0] === "splice-block"
          ? body.push(...transformed.splice(1))
          : body.push(transformed);
        return body;
      }, []);
      return module;
    });
  },
  extract: (_, list: AST, index: number) => list[index],
  block: (_, ...expressions: AST[]) => expressions[expressions.length - 1],
  array: (_, ...rest: AST[]) => rest,
  slice: (_, array: AST, index: number) => array.slice(index),
  length: (_, array: AST) => array.length,
  "define-mut": ({ vars, macros }, id: string, value: Expr) => {
    vars.set(id, { value: evalExpr(value, { vars, macros }), mutable: true });
    return value;
  },
  define: ({ vars, macros }, id: string, value: Expr) => {
    vars.set(id, { value: evalExpr(value, { vars, macros }), mutable: false });
    return value;
  },
  // TODO: Support overloading
  "define-function": (
    { vars },
    id: string,
    parameters: ["parameters", [string, string][]],
    variables: AST,
    returnType: AST,
    body: AST
  ) => {
    const lambda = [
      "lambda-expr",
      parameters.slice(1).map((p) => p[0] as string),
      ...body,
    ];
    vars.set(id, { value: lambda, mutable: false });
    return ["define-function", id, parameters, variables, returnType, body];
  },
  "=": ({ vars }, identifier, expr) => {
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
  "lambda-expr": (_, ...lambda) => ["lambda-expr", ...lambda],
  quote: ({ vars, macros }, ...quote: AST) => {
    const expand = (body: AST) =>
      body.reduce((ast: AST, exp) => {
        if (isList(exp) && exp[0] === "$") {
          ast.push(evalExpr(exp.slice(1), { vars, macros }));
          return ast;
        }

        if (isList(exp) && exp[0] === "$@") {
          ast.push(...(evalExpr(exp.slice(1), { vars, macros }) as AST));
          return ast;
        }

        if (isList(exp)) {
          ast.push(expand(exp));
          return ast;
        }

        if (typeof exp === "string" && exp.startsWith("$@")) {
          const id = exp.replace("$@", "");
          const value = vars.get(id)?.value as AST;
          ast.push(...(value ?? []));
          return ast;
        }

        if (typeof exp === "string" && exp.startsWith("$")) {
          ast.push(vars.get(exp.replace("$", ""))?.value!);
          return ast;
        }

        if (typeof exp === "string" && exp.startsWith("\\")) {
          ast.push(exp.replace("\\", ""));
          return ast;
        }

        ast.push(exp);
        return ast;
      }, []);
    return expand(quote);
  },
  if: ({ vars, macros }, condition: Expr, ifTrue: Expr, ifFalse: Expr) => {
    const condResult = evalExpr(handleOptionalConditionParenthesis(condition), {
      vars,
      macros,
    });
    if (condResult) {
      return evalExpr(ifTrue, { macros, vars });
    }
    if (ifFalse) {
      return evalExpr(ifFalse, { macros, vars });
    }
    return [];
  },
  map: ({ vars, macros }, array: AST, lambda: AST) => {
    return array.map((val, index, array) =>
      callLambda({
        lambda,
        macros,
        vars,
        args: [val, index, array],
      })
    );
  },
  reduce: ({ vars, macros }, array: AST, start: Expr, lambda: AST) => {
    return array.reduce(
      (prev, cur, index, array) =>
        callLambda({
          lambda,
          macros,
          vars,
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
  split: (_, str: string, splitter: string) => str.split(splitter),
  "macro-expand": ({ macros, vars }, body: AST) =>
    expandMacros(body, macros, vars),
  "char-to-code": (_, char: string) => String(char).charCodeAt(0),
  eval: (opts, body: AST) => evalFnCall(body, opts),
  "register-macro": ({ macros }, ast: AST) => {
    registerMacro(macros, ast);
    return [];
  },
};

const fnsToSkipArgEval = new Set([
  "if",
  "quote",
  "lambda-expr",
  "root",
  "module",
  "macro",
  "splice-block",
  "define",
  "define-mut",
  "define-function",
]);

const handleOptionalConditionParenthesis = (expr: Expr): Expr => {
  if (isList(expr) && expr.length === 1 && isList(expr[0])) {
    return expr[0];
  }
  return expr;
};

const isLambda = (expr: Expr): boolean => {
  if (!isList(expr)) return false;
  return expr[0] === "lambda-expr";
};

/** Slice out the beginning macro before calling */
const registerMacro = (macros: Macros, ast: AST) => {
  const id = ((ast[0] as AST)[0] as string).replace(/\'/g, "");
  macros.set(id, ast);
};
