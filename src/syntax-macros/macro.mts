import { ModuleInfo } from "../lib/module-info.mjs";
import {
  Bool,
  Expr,
  Float,
  Identifier,
  Int,
  isFloat,
  isIdentifier,
  isList,
  isStringLiteral,
  List,
  Syntax,
} from "../lib/syntax.mjs";

/** TODO: Support macro scoping / module import checking */
type Macros = Map<string, List>;

/** Transforms macro's into their final form and then runs them */
export const macro = (list: List, info: ModuleInfo): List => {
  if (!info.isRoot) return list;
  const macros: Macros = new Map();
  return evalExpr(list, { macros }) as List;
};

type EvalExprOpts = {
  macros: Macros;
};

const evalExpr = (expr: Expr, { macros }: EvalExprOpts) => {
  if (isFloat(expr)) return expr;
  if (isStringLiteral(expr)) return expr;
  if (isIdentifier(expr)) return expr.assertedResult();
  if (!isList(expr)) return expr;
  return evalFnCall(expr, { macros });
};

const evalFnCall = (list: List, { macros }: EvalExprOpts): Expr => {
  const identifier = list.first();
  if (!isIdentifier(identifier)) {
    return list;
  }

  const shouldSkipArgEval = fnsToSkipArgEval.has(identifier.value);

  const args = !shouldSkipArgEval
    ? list.rest().map((exp) => evalExpr(exp, { macros }))
    : list.rest();

  const variable = identifier.getResult();
  if (isLambda(variable)) {
    return callLambda({
      lambda: variable,
      macros,
      args,
    });
  }

  if (!functions[identifier.value]) {
    return list;
  }

  return functions[identifier.value](
    { macros, identifier, parent: list },
    args
  );
};

const expandMacros = (list: Expr, macros: Macros): Expr => {
  if (!isList(list)) return list;
  const identifier = list.first();
  if (isIdentifier(identifier)) {
    const macro = macros.get(identifier.value);
    if (macro) return expandMacro({ macro, call: list, macros });
  }

  return list.reduce((expr) => {
    if (!isList(expr)) return expr;

    const identifier = expr.first();
    if (!isIdentifier(identifier)) {
      return expandMacros(expr, macros);
    }

    const macro = macros.get(identifier.value);
    if (!macro) return expandMacros(expr, macros);

    return expandMacro({ macro, call: expr, macros });
  });
};

/** Expands a macro call */
const expandMacro = ({
  macro,
  call,
  macros,
}: {
  macro: List;
  call: List;
  macros: Macros;
}): Expr => {
  macro.setVar(new Identifier({ value: "&body", bind: call.rest() }));
  const result = macro.rest().map((exp) => evalExpr(exp, { macros }));
  return expandMacros(result.pop()!, macros) ?? [];
};

type CallLambdaOpts = {
  lambda: List;
  args: List;
  macros: Macros;
};

const callLambda = (opts: CallLambdaOpts): Expr => {
  const lambda = opts.lambda.rest();
  const body = lambda.at(1);

  if (!body) {
    throw new Error("Expected body");
  }

  return evalExpr(body, { macros: opts.macros });
};

type FnOpts = {
  parent: Syntax;
  identifier: Identifier;
  macros: Macros;
};

const functions: Record<string, (opts: FnOpts, args: List) => Expr> = {
  macro: ({ macros }, macro) => {
    registerMacro(macros, expandMacros(macro, macros) as List);
    return nop();
  },
  root: ({ macros, identifier }, root) => {
    root.insert(identifier);
    return root.map((module) => {
      if (!isList(module)) return module;
      module.value[4] = (module.value[4] as List).reduce((expr) => {
        if (!isList(expr)) return evalExpr(expr, { macros });
        return evalExpr(expandMacros(expr, macros), { macros });
      });
      return module;
    });
  },
  block: (_, args) => args.at(-1)!,
  length: (_, array) => array.length,
  "define-mut": ({ macros, parent }, args) => {
    // Warning: Cannot be typed like would be at compile time (for now);
    const identifier = args.at(0);
    const init = args.at(1);
    if (!isIdentifier(identifier) || !init) {
      throw new Error("Invalid variable");
    }
    identifier.isMutable = true;
    identifier.bind = init;
    identifier.setKind("var");
    identifier.setResult(evalExpr(init, { macros }));
    parent.setVar(identifier);
    return nop();
  },
  define: ({ parent, macros }, args) => {
    const identifier = args.at(0);
    const init = args.at(1);
    if (!isIdentifier(identifier) || !init) {
      throw new Error("Invalid variable");
    }
    identifier.isMutable = true;
    identifier.bind = init;
    identifier.setKind("var");
    identifier.setResult(evalExpr(init, { macros }));
    parent.setVar(identifier);
    return nop();
  },
  // TODO: Support functions in macro expansion phase
  "define-function": ({ identifier }, args) => {
    return args.insert(identifier);
  },
  "=": ({ macros, parent }, args) => {
    const identifier = args.first();
    if (!isIdentifier(identifier) || !identifier.isDefined) {
      throw new Error(`identifier not found ${identifier}`);
    }

    if (!identifier.isMutable) {
      throw new Error(`Variable ${identifier} is not mutable`);
    }

    identifier.setResult(evalExpr(args.at(1)!, { macros }));
    return new List({ parent });
  },
  "==": (_, args) => bl(args, (l, r) => l === r),
  ">": (_, args) => bl(args, (l, r) => l > r),
  ">=": (_, args) => bl(args, (l, r) => l >= r),
  "<": (_, args) => bl(args, (l, r) => l < r),
  "<=": (_, args) => bl(args, (l, r) => l <= r),
  and: (_, args) => bl(args, (l, r) => l && r),
  or: (_, args) => bl(args, (l, r) => l || r),
  not: (_, args) => bool(!args.first()?.value),
  "+": (_, args) => ba(args, (l, r) => l + r),
  "-": (_, args) => ba(args, (l, r) => l - r),
  "*": (_, args) => ba(args, (l, r) => l * r),
  "/": (_, args) => ba(args, (l, r) => l / r),
  "lambda-expr": (_, args) => {
    const params = args.first();
    const body = args.at(1);
    const lambda = args.insert("lambda-expr");

    if (!isList(params) || !body) {
      console.error(JSON.stringify(lambda, undefined, 2));
      throw new Error("invalid lambda expression");
    }

    // For now, assumes params are untyped
    params.map((p) => {
      if (!isIdentifier(p)) {
        console.error(JSON.stringify(p, undefined, 2));
        throw new Error("Invalid lambda parameter");
      }

      p.bind = new List({});
      p.setKind("param");
      lambda.setVar(p);
      return p;
    });

    return lambda;
  },
  quote: ({ macros }, quote: List) => {
    const expand = (body: List): List =>
      body.reduce((exp) => {
        if (isList(exp) && exp.first()?.is("$")) {
          return evalExpr(exp.rest(), { macros });
        }

        if (isList(exp) && exp.first()?.is("$@")) {
          const result = evalExpr(exp.rest(), { macros }) as List;
          result.insert("splice-block");
          return result;
        }

        if (isList(exp)) return expand(exp);

        if (isIdentifier(exp) && exp.value.startsWith("$@")) {
          const id = exp.value.replace("$@", "");
          const value = exp.getVar(id)!;
          const list = value.assertedResult() as List;
          list.insert("splice-block");
          return list;
        }

        if (isIdentifier(exp) && exp.value.startsWith("$")) {
          const id = exp.value.replace("$@", "");
          const value = exp.getVar(id)!;
          return value.assertedResult();
        }

        if (isIdentifier(exp) || isStringLiteral(exp)) {
          exp.value = exp.value.replace("\\", "");
        }

        return exp;
      });
    return expand(quote);
  },
  if: ({ macros }, args) => {
    const condition = args.at(0);
    const ifTrue = args.at(1);
    const ifFalse = args.at(2);

    if (!condition || !ifTrue) {
      console.log(JSON.stringify(args, undefined, 2));
      throw new Error("Invalid if expr");
    }

    const condResult = evalExpr(handleOptionalConditionParenthesis(condition), {
      macros,
    });

    if (condResult.value) {
      return evalExpr(ifTrue, { macros });
    }

    if (ifFalse) {
      return evalExpr(ifFalse, { macros });
    }

    return nop();
  },
  array: (_, args) => args,
  slice: (_, args) => {
    const list = args.first()! as List;
    const start = args.at(1)?.value as number | undefined;
    const end = args.at(2)?.value as number | undefined;
    return list.slice(start, end);
  },
  extract: (_, args) => {
    const list = args.first()! as List;
    const index = args.at(1)!.value as number;
    return list.at(index)!; // TODO: Make this safer
  },
  map: ({ macros, parent }, args) => {
    const list = args.first()! as List;
    const lambda = args.at(1)! as List;
    return list.map((val, index, array) =>
      callLambda({
        lambda,
        macros,
        args: new List({
          value: [
            val,
            new Int({ value: index }),
            new List({ value: array, parent }),
          ],
          parent,
        }),
      })
    );
  },
  reduce: ({ macros }, args) => {
    const list = args.at(0)! as List;
    const start = args.at(1)!;
    const lambda = args.at(2)! as List;
    return list.value.reduce(
      (prev, cur, index, array) =>
        callLambda({
          lambda,
          macros,
          vars,
          args: [prev, cur, index, array],
        }),
      start.value
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
  "=",
]);

const handleOptionalConditionParenthesis = (expr: Expr): Expr => {
  if (isList(expr) && expr.length === 1 && isList(expr[0])) {
    return expr[0];
  }
  return expr;
};

const isLambda = (expr?: Expr): expr is List => {
  if (!isList(expr)) return false;
  return expr.first()?.is("lambda-expr") ?? false;
};

/** Slice out the beginning macro before calling */
const registerMacro = (macros: Macros, ast: AST) => {
  const id = ((ast[0] as AST)[0] as string).replace(/\'/g, "");
  macros.set(id, ast);
};

const nop = () => new List({}).push(Identifier.from("splice-block"));
/** Binary logical comparison */
const bl = (args: List, fn: (l: any, r: any) => boolean) =>
  bool(fn(args.at(0)?.value, args.at(1)?.value));
/** Binary arithmetic operation */
const ba = (args: List, fn: (l: any, r: any) => number) =>
  new Float({ value: fn(args.at(0)?.value, args.at(1)?.value) });
const bool = (b: boolean) => new Bool({ value: b });
