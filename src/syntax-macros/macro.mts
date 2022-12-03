import { isFloat } from "../lib/is-float.mjs";
import { isList } from "../lib/is-list.mjs";
import { isString } from "../lib/is-string.mjs";
import { ModuleInfo } from "../lib/module-info.mjs";
import { AST, Expr } from "../parser.mjs";

/** TODO: Support macro scoping / module import checking */
type Macros = Map<string, AST>;

/** Transforms macro's into their final form and then runs them */
export const macro = (ast: AST, info: ModuleInfo): AST => {
  if (!info.isRoot) return ast;
  const macros: Macros = new Map();
  // const { macros, transformed } = registerMacros(ast);
  return expandMacros(ast, macros);
};

// // NOTE: The pub macro does this for us. This c
// /** Registers macros and removes them. For now we cheat and interpret `macro` directly rather than transforming it */
// const registerMacros = (ast: AST): { transformed: AST; macros: Macros } => {
//   let macros: Macros = new Map();
//   const transformed: AST = [];

//   for (const expr of ast) {
//     if (!isList(expr)) {
//       transformed.push(expr);
//       continue;
//     }

//     if (expr[0] !== "macro") {
//       const sub = registerMacros(expr);
//       macros = new Map([...macros, ...sub.macros]);
//       transformed.push(sub.transformed);
//       continue;
//     }

//     registerMacro(macros, expr);
//   }

//   // Expand macro calls within macros
//   for (const [id, macro] of macros.entries()) {
//     macros.set(id, [
//       ...macro.slice(0, 2),
//       ...macro.slice(2).map((exp) => expandMacro(exp, macros)),
//     ]);
//   }

//   return { transformed, macros };
// };

const registerMacro = (macros: Macros, ast: AST) => {
  const id = ((ast[1] as AST)[0] as string).replace(/\'/g, "");
  macros.set(id, ast);
};

const expandMacros = (ast: AST, macros: Macros): AST => {
  return ast.reduce((newAst: AST, expr) => {
    if (isList(expr) && expr[0] === "macro") {
      registerMacro(macros, expandMacro(expr, macros) as AST);
      return newAst;
    }

    if (isList(expr)) {
      const expanded = expandMacro(expr, macros);
      const result = isList(expanded)
        ? expandMacros(expanded, macros)
        : expanded;
      isList(result) && result[0] === "splice-block"
        ? newAst.push(...result.slice(1))
        : newAst.push(result);
      return newAst;
    }

    newAst.push(expr);
    return newAst;
  }, []);
};

/** Expands a macro call. Assumes expr is a macro call */
const expandMacro = (
  expr: Expr,
  macros: Macros,
  vars: Variables = new Map()
): Expr => {
  if (!isList(expr)) return expr;
  const macro = macros.get(expr[0] as string);
  if (!macro) return expandMacros(expr, macros);

  const variables: Variables = new Map([
    ...vars,
    ...mapMacroParameters(expr, (macro[1] as string[]).slice(1)),
  ]);
  variables.set("&body", { value: expr.slice(1), mutable: false });
  const result = macro
    .slice(2)
    .map((exp) => evalExpr(exp, { macros, vars: variables }));
  return result.pop() ?? [];
};

const mapMacroParameters = (callExpr: AST, parameters: string[]) =>
  parameters.reduce((vars: Variables, name, index) => {
    const value = callExpr[index + 1];
    vars.set(name, { value, mutable: false });
    return vars;
  }, new Map());

type Variable = { value: Expr; mutable: boolean };
type Variables = Map<string, Variable>;
type EvalExprOpts = {
  vars: Variables;
  macros: Macros;
};

const evalExpr = (fn: Expr, { vars, macros }: EvalExprOpts): Expr => {
  if (typeof fn === "string") {
    return vars?.get(fn)?.value ?? fn;
  }

  if (!isList(fn)) return fn;
  const identifier = fn[0];

  if (typeof identifier !== "string") {
    return identifier;
  }

  const shouldSkipArgEval =
    identifier === "if" ||
    identifier === "lambda-expr" ||
    identifier === "quote";

  const args: AST = !shouldSkipArgEval
    ? fn.slice(1).map((exp) => {
        if (exp instanceof Array) {
          return evalExpr(exp, { macros, vars });
        }

        if (typeof exp === "number") return exp;
        if (typeof exp === "boolean") return exp;
        if (isFloat(exp)) return Number(exp.replace("/float", ""));
        if (isString(exp)) return exp.replace(/\"/g, "");
        return vars?.get(exp)?.value ?? exp;
      })
    : fn.slice(1);

  const variable = vars?.get(identifier)?.value;
  if (variable && isLambda(variable)) {
    return callLambda({
      lambda: variable,
      macros,
      vars,
      args,
    });
  }

  if (variable) {
    return variable;
  }

  if (!functions[identifier]) {
    return fn;
  }

  return functions[identifier]({ vars, macros }, ...args);
};

type CallLambdaOpts = {
  lambda: any;
  args: AST;
  vars: Variables;
  macros: Macros;
};

const callLambda = (opts: CallLambdaOpts): Expr => {
  const lambda = opts.lambda.slice(1);
  const parameters = lambda[0];
  const body = lambda[1];
  const vars = new Map([
    ...opts.vars,
    ["&lambda", { mutable: false, value: opts.lambda }],
    ...(parameters instanceof Array ? parameters : [parameters]).map(
      (p, index): [string, Variable] => [
        p,
        { mutable: false, value: opts.args[index] },
      ]
    ),
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
  extract: (_, list: AST, index: number) => list[index],
  block: (_, ...expressions: Expr[]) => expressions[expressions.length - 1],
  array: (_, ...rest: Expr[]) => rest,
  slice: (_, array: AST, index: number) => array.slice(index),
  length: (_, array: AST) => array.length,
  "define-mut": ({ vars }, id: string, value: Expr) => {
    vars.set(id, { value, mutable: true });
    return value;
  },
  define: ({ vars }, id: string, value: Expr) => {
    vars.set(id, { value, mutable: false });
    return value;
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
  "macro-expand": ({ macros }, body: AST) => expandMacro(body, macros),
  eval: (opts, body: AST) => evalExpr(body, opts),
  "register-macro": ({ macros }, ast: AST) => {
    registerMacro(macros, ast);
    return [];
  },
};

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
