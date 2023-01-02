import { ModuleInfo } from "../lib/module-info.mjs";
import {
  Bool,
  Expr,
  Float,
  Id,
  Identifier,
  Int,
  isFloat,
  isIdentifier,
  isList,
  isStringLiteral,
  List,
  StringLiteral,
} from "../lib/syntax/index.mjs";

/** Transforms macro's into their final form and then runs them */
export const macro = (list: List, info: ModuleInfo): List => {
  if (!info.isRoot) return list;
  return evalExpr(list) as List;
};

const evalExpr = (expr: Expr) => {
  if (isFloat(expr)) return expr;
  if (isStringLiteral(expr)) return expr;
  if (isIdentifier(expr)) return expr.assertedResult();
  if (!isList(expr)) return expr;
  return evalFnCall(expr);
};

const evalFnCall = (list: List): Expr => {
  const identifier = list.first();
  if (!isIdentifier(identifier)) {
    return list;
  }

  const shouldSkipArgEval = fnsToSkipArgEval.has(identifier.value);

  const args = !shouldSkipArgEval
    ? list.rest().map((exp) => evalExpr(exp))
    : list.rest();

  const variable = identifier.getResult();
  if (isLambda(variable)) {
    return callLambda({
      lambda: variable,
      args,
    });
  }

  if (!functions[identifier.value]) {
    return list;
  }

  return functions[identifier.value]({ identifier, parent: list }, args);
};

const expandMacros = (list: Expr): Expr => {
  if (!isList(list)) return list;
  const identifier = list.first();
  if (isIdentifier(identifier)) {
    const macro = getMacro(identifier, list);
    if (macro) return expandMacro({ macro, call: list });
  }

  return list.reduce((expr) => {
    if (!isList(expr)) return expr;

    const identifier = expr.first();
    if (!isIdentifier(identifier)) {
      return expandMacros(expr);
    }

    const macro = getMacro(identifier, list);
    if (!macro) return expandMacros(expr);

    return expandMacro({ macro, call: expr });
  });
};

/** Expands a macro call */
const expandMacro = ({ macro, call }: { macro: List; call: List }): Expr => {
  macro.setVar("&body", { kind: "param", value: call.rest() });
  const result = macro.rest().map((exp) => evalExpr(exp));
  return expandMacros(result.pop()!) ?? [];
};

type CallLambdaOpts = {
  lambda: List;
  args: List;
};

const callLambda = (opts: CallLambdaOpts): Expr => {
  const lambda = opts.lambda.rest();
  const body = lambda.at(1);

  if (!body) {
    throw new Error("Expected body");
  }

  return evalExpr(body);
};

type FnOpts = {
  parent: Expr;
  identifier: Identifier;
};

const functions: Record<string, (opts: FnOpts, args: List) => Expr> = {
  macro: ({ parent }, macro) => {
    registerMacro(expandMacros(macro) as List, parent);
    return nop();
  },
  root: ({ identifier }, root) => {
    root.insert(identifier);
    return root.map((module) => {
      if (!isList(module)) return module;
      module.value[4] = (module.value[4] as List).reduce((expr) => {
        if (!isList(expr)) return evalExpr(expr);
        return evalExpr(expandMacros(expr));
      });
      return module;
    });
  },
  block: (_, args) => args.at(-1)!,
  length: (_, array) => array.length,
  "define-mut": ({ parent }, args) => {
    // Warning: Cannot be typed like would be at compile time (for now);
    const identifier = args.at(0);
    const init = args.at(1);
    if (!isIdentifier(identifier) || !init) {
      throw new Error("Invalid variable");
    }
    identifier.binding = init;
    parent.setVar(identifier, {
      kind: "var",
      mut: true,
      value: evalExpr(init),
    });
    return nop();
  },
  define: ({ parent }, args) => {
    // Warning: Cannot be typed like would be at compile time (for now);
    const identifier = args.at(0);
    const init = args.at(1);
    if (!isIdentifier(identifier) || !init) {
      throw new Error("Invalid variable");
    }
    identifier.binding = init;
    parent.setVar(identifier, {
      kind: "var",
      mut: false,
      value: evalExpr(init),
    });
    return nop();
  },
  // TODO: Support functions in macro expansion phase
  "define-function": ({ identifier }, args) => {
    return args.insert(identifier);
  },
  "=": ({ parent }, args) => {
    const identifier = args.first();
    if (!isIdentifier(identifier)) {
      throw new Error(`Expected identifier, got ${identifier}`);
    }

    const info = parent.getVar(identifier);
    if (!info) {
      throw new Error(`Identifier ${identifier.value} is not defined`);
    }

    if (!info.mut) {
      throw new Error(`Variable ${identifier} is not mutable`);
    }

    info.value = evalExpr(args.at(1)!);
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

      lambda.setVar(p, { kind: "param" });
      return p;
    });

    return lambda;
  },
  quote: (_, quote: List) => {
    const expand = (body: List): List =>
      body.reduce((exp) => {
        if (isList(exp) && exp.first()?.is("$")) {
          return evalExpr(exp.rest());
        }

        if (isList(exp) && exp.first()?.is("$@")) {
          const result = evalExpr(exp.rest()) as List;
          result.insert("splice-block");
          return result;
        }

        if (isList(exp)) return expand(exp);

        if (isIdentifier(exp) && exp.value.startsWith("$@")) {
          const id = exp.value.replace("$@", "");
          const info = exp.getVar(id)!;
          const list = info.value as List;
          list.insert("splice-block");
          return list;
        }

        if (isIdentifier(exp) && exp.value.startsWith("$")) {
          const id = exp.value.replace("$@", "");
          return exp.getVar(id)!.value!;
        }

        if (isIdentifier(exp) || isStringLiteral(exp)) {
          exp.value = exp.value.replace("\\", "");
        }

        return exp;
      });
    return expand(quote);
  },
  if: (_, args) => {
    const condition = args.at(0);
    const ifTrue = args.at(1);
    const ifFalse = args.at(2);

    if (!condition || !ifTrue) {
      console.log(JSON.stringify(args, undefined, 2));
      throw new Error("Invalid if expr");
    }

    const condResult = evalExpr(handleOptionalConditionParenthesis(condition));

    if (condResult.value) {
      return evalExpr(ifTrue);
    }

    if (ifFalse) {
      return evalExpr(ifFalse);
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
  map: ({ parent }, args) => {
    const list = args.first()! as List;
    const lambda = args.at(1)! as List;
    return list.map((val, index, array) =>
      callLambda({
        lambda,
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
  reduce: (_, args) => {
    const list = args.at(0)! as List;
    const start = args.at(1)!;
    const lambda = args.at(2)! as List;
    return list.value.reduce(
      (prev, cur, index, array) =>
        callLambda({
          lambda,
          args: new List({
            value: [
              prev,
              cur,
              new Float({ value: index }),
              new List({ value: array }),
            ],
          }),
        }),
      evalExpr(start)
    );
  },
  push: (_, args) => {
    const list = args.at(0) as List;
    const val = args.at(1)!;
    list.push(val);
    return list;
  },
  concat: (_, args) => {
    const list = args.first() as List;
    list.push(...args.rest().value.flatMap((expr) => (expr as List).value));
    return list;
  },
  "is-list": (_, args) => bool(isList(args.at(0))),
  log: (_, arg) => {
    console.error(JSON.stringify(arg, undefined, 2));
    return arg;
  },
  split: ({ parent }, arg) => {
    const str = arg.at(0) as StringLiteral;
    const splitter = arg.at(0) as StringLiteral;
    return new List({ value: str.value.split(splitter.value), parent });
  },
  "macro-expand": (_, args) => expandMacros(args),
  "char-to-code": (_, args) =>
    new Int({
      value: String((args.at(0) as StringLiteral).value).charCodeAt(0),
    }),
  eval: (_, body) => evalFnCall(body),
  "register-macro": ({ parent }, args) => {
    registerMacro(args, parent);
    return nop();
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
  if (isList(expr) && isList(expr.first())) {
    return expr.first()!;
  }

  return expr;
};

const isLambda = (expr?: Expr): expr is List => {
  if (!isList(expr)) return false;
  return expr.first()?.is("lambda-expr") ?? false;
};

/** Slice out the beginning macro before calling */
const registerMacro = (list: List, parent: Expr) => {
  const id = list.first() as Identifier;
  parent.setVar(id.value, { value: list, kind: "var" });
};

const nop = () => new List({}).push(Identifier.from("splice-block"));
/** Binary logical comparison */
const bl = (args: List, fn: (l: any, r: any) => boolean) =>
  bool(fn(args.at(0)?.value, args.at(1)?.value));
/** Binary arithmetic operation */
const ba = (args: List, fn: (l: any, r: any) => number) =>
  new Float({ value: fn(args.at(0)?.value, args.at(1)?.value) });
const bool = (b: boolean) => new Bool({ value: b });

const getMacro = (id: Id, scope: Expr) =>
  scope.getVar(id)?.value as List | undefined;
