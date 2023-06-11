import { ModuleInfo } from "../lib/module-info.mjs";
import { getIdStr } from "../lib/syntax/get-id-str.mjs";
import {
  Bool,
  Expr,
  Float,
  Identifier,
  Int,
  isFloat,
  isIdentifier,
  isInt,
  isList,
  isStringLiteral,
  List,
  StringLiteral,
} from "../lib/syntax/index.mjs";
import { MacroLambda } from "../lib/syntax/macro-lambda.mjs";
import { MacroVariable } from "../lib/syntax/macro-variable.mjs";
import { Macro, RegularMacro } from "../lib/syntax/macros.mjs";

/** Transforms macro's into their final form and then runs them */
export const macro = (list: List, info: ModuleInfo): List => {
  if (!info.isRoot) return list;
  return evalExpr(list) as List;
};

const evalExpr = (expr: Expr) => {
  if (isIdentifier(expr)) return evalIdentifier(expr);
  if (!isList(expr)) return expr;
  return evalFnCall(expr);
};

const evalIdentifier = (expr: Identifier): Expr => {
  const entity = expr.resolveAsMacroEntity();
  if (!entity) return expr;
  if (entity.syntaxType !== "macro-variable") return expr;
  if (!entity.value) return expr;
  return entity.value;
};

const evalFnCall = (list: List): Expr => {
  const identifier = list.first();
  if (!isIdentifier(identifier)) {
    return list;
  }

  const entity = identifier.resolveAsMacroEntity();
  if (!entity) {
    return list;
  }

  if (entity.syntaxType === "macro") {
    const expanded = expandMacro({ macro: entity, call: list });
    return evalExpr(expanded);
  }

  const value = entity.value;
  if (!value) {
    return list;
  }

  const idStr = getIdStr(identifier);
  const shouldSkipArgEval = fnsToSkipArgEval.has(idStr);
  const argsArr = !shouldSkipArgEval ? list.rest().map(evalExpr) : list.rest();
  const args = new List({ value: argsArr, parent: list.getParent() });

  const stdFn = functions[idStr];
  if (stdFn) {
    return stdFn({ identifier, parent: list.getParent() ?? list }, args);
  }

  if (value.syntaxType === "macro-lambda") {
    return callLambda({ lambda: value, args });
  }

  return list;
};

/** Expands a macro call */
const expandMacro = ({ macro, call }: { macro: Macro; call: List }): Expr => {
  const clone = macro.clone();

  // Register parameters
  clone.parameters.forEach((identifier, index) => {
    clone.registerEntity(
      identifier,
      new MacroVariable({
        identifier,
        value: call.at(index + 1)!,
        isMutable: false,
      })
    );
  });

  // Implicit &body param
  const bodyIdentifier = new Identifier({ value: "&body" });
  clone.registerEntity(
    bodyIdentifier,
    new MacroVariable({
      identifier: bodyIdentifier,
      value: new List({ value: call.rest() }),
      isMutable: false,
    })
  );

  return clone.body.map((exp) => evalExpr(exp)).at(-1) ?? nop();
};

type CallLambdaOpts = {
  lambda: MacroLambda;
  args: List;
};

const callLambda = (opts: CallLambdaOpts): Expr => {
  const clone = opts.lambda.clone();
  clone.registerEntity(
    "&lambda",
    new MacroVariable({
      identifier: new Identifier({ value: "&lambda" }),
      value: opts.lambda.clone(),
      isMutable: false,
    })
  );

  clone.parameters.forEach((identifier, index) =>
    clone.registerEntity(
      identifier,
      new MacroVariable({
        identifier,
        value: opts.args.at(index)!,
        isMutable: false,
      })
    )
  );

  return clone.body.map((exp) => evalExpr(exp)).at(-1) ?? nop();
};

type FnOpts = {
  parent: Expr;
  identifier: Identifier;
};

const functions: Record<
  string,
  ((opts: FnOpts, args: List) => Expr) | undefined
> = {
  macro: (_, macro) => {
    const result = expandMacros(macro) as List;
    registerMacro(result);
    return result;
  },
  root: ({ identifier }, root) => {
    root.insert(identifier);
    return root.map((module) => {
      if (!isList(module)) return module;
      module.value[4] = (module.value[4] as List).reduce(evalExpr);
      return module;
    });
  },
  block: (_, args) => args.at(-1)!,
  length: (_, args) => (args.first()! as List).length,
  "define-mut": ({ parent }, args) =>
    defineVar({ args, parent, kind: "var", mut: true }),
  define: ({ parent }, args) => defineVar({ args, parent, kind: "var" }),
  "define-macro-var": ({ parent }, args) =>
    defineVar({ args, parent, kind: "global" }),
  "define-mut-macro-var": ({ parent }, args) =>
    defineVar({ args, parent, kind: "global", mut: true }),
  Identifier: (_, args) => {
    const nameDef = args.at(0);
    const name = isList(nameDef)
      ? evalExpr(nameDef.at(2)!)
      : (nameDef as Identifier);
    return new Identifier({ value: name.value as string });
  },
  export: (_, args) => {
    const id = args.first() as Identifier;
    const fn = currentModuleScope.getFns(id)?.[0];
    const parent = currentModuleScope.getParent();
    if (fn && parent) {
      parent.addFn(id, fn);
    }
    return args.insert("export");
  },
  "=": ({ parent }, args) => {
    const identifier = args.first();
    if (!isIdentifier(identifier)) {
      throw new Error(`Expected identifier, got ${identifier}`);
    }

    const info = parent.resolveEntity(identifier);
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

      lambda.addVar(p, { kind: "var" });
      return p;
    });

    return lambda;
  },
  quote: (_, quote: List) => {
    const expand = (body: List): List =>
      body.reduce((exp) => {
        if (isList(exp) && exp.first()?.is("$")) {
          return evalExpr(new List({ value: exp.rest(), parent: body }));
        }

        if (isList(exp) && exp.first()?.is("$@")) {
          const rest = new List({ value: exp.rest(), parent: body });
          return (evalExpr(rest) as List).insert("splice-quote");
        }

        if (isList(exp)) return expand(exp);

        if (isIdentifier(exp) && exp.value.startsWith("$@")) {
          const id = exp.value.replace("$@", "");
          const info = exp.resolveEntity(id)!;
          const list = info.value as List;
          list.insert("splice-quote");
          return list;
        }

        if (isIdentifier(exp) && exp.value.startsWith("$")) {
          const id = exp.value.replace("$", "");
          return exp.resolveEntity(id)!.value!;
        }

        return exp;
      });
    return expand(quote);
  },
  if: (_, args) => {
    const [condition, ifTrue, ifFalse] = args.value;

    if (!condition || !ifTrue) {
      console.log(JSON.stringify(args, undefined, 2));
      throw new Error("Invalid if expr");
    }

    const condResult = evalExpr(handleOptionalConditionParenthesis(condition));

    if (getRuntimeValue(condResult)) {
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
    const start = getRuntimeValue(args.at(1)) as number | undefined;
    const end = getRuntimeValue(args.at(2)) as number | undefined;
    return list.slice(start, end);
  },
  extract: (_, args) => {
    const list = args.first()! as List;
    const index = getRuntimeValue(args.at(1)) as number;
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
    return list.push(val);
  },
  spread: (_, args) => {
    const list = args.at(0) as List;
    const val = args.at(1)! as List;
    return list.push(...val.value);
  },
  concat: (_, args) => {
    const list = args.first() as List;
    return list.push(...args.rest().flatMap((expr) => (expr as List).value));
  },
  "is-list": (_, args) => bool(isList(args.at(0))),
  log: (_, arg) => {
    console.error(JSON.stringify(arg.first(), undefined, 2));
    return arg;
  },
  split: ({ parent }, arg) => {
    const str = arg.at(0) as StringLiteral;
    const splitter = arg.at(0) as StringLiteral;
    return new List({ value: str.value.split(splitter.value), parent });
  },
  "macro-expand": (_, args) => expandMacros(args.at(0)!),
  "char-to-code": (_, args) =>
    new Int({
      value: String((args.at(0) as StringLiteral).value).charCodeAt(0),
    }),
  eval: (_, body) => evalFnCall(body),
  "register-macro": (_, args) => {
    registerMacro(args.at(0) as List);
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
  "define",
  "define-mut",
  "define-global",
  "define-mut-global",
  "define-function",
  "define-macro-var",
  "define-mut-macro-var",
  "=",
  "export",
]);

const handleOptionalConditionParenthesis = (expr: Expr): Expr => {
  if (isList(expr) && isList(expr.first())) {
    return expr.first()!;
  }

  return expr;
};

/** Slice out the beginning macro before calling */
const registerMacro = (list: List) => {
  // TODO Assertions?
  const signature = list.first() as List;
  const identifier = signature.first() as Identifier;
  const parameters = signature.rest() as Identifier[];
  const body = list.slice(1);
  const macro = new RegularMacro({
    inherit: list,
    identifier,
    parameters,
    body,
  });
  macro.getParent()?.registerEntity(identifier, macro);
  return nop();
};

const nop = () => new List({}).push(Identifier.from("splice-quote"));
/** Binary logical comparison */
const bl = (
  args: List,
  fn: (l: MacroRuntimeValue, r: MacroRuntimeValue) => boolean
) => bool(fn(getRuntimeValue(args.at(0)), getRuntimeValue(args.at(1))));

/** Binary arithmetic operation */
const ba = (
  args: List,
  fn: (l: MacroRuntimeValue, r: MacroRuntimeValue) => MacroRuntimeValue
) => {
  const left = args.at(0);
  const right = args.at(1);
  const value = fn(getRuntimeValue(left), getRuntimeValue(right));

  if (
    typeof value === "number" &&
    isInt(left) &&
    isInt(right) &&
    value % 1 === 0
  ) {
    return new Int({ value });
  }

  // Yucky. What was I thinking, concatenating strings with +
  if (typeof value === "string") {
    return new StringLiteral({ value });
  }

  if (typeof value === "undefined") {
    throw new Error(`Invalid macro binary arithmetic expression ${args}`);
  }

  return new Float({ value });
};
const bool = (b: boolean) => new Bool({ value: b });

const getMacro = (id: Identifier): List | undefined => {
  const fn = id.getFns(id)?.[0];
  if (!fn?.flags.has("isMacro")) return;
  return fn.props.get("body") as List;
};

/**
 * Used to interpret the real value of a macro entity. This means we convert syntax objects
 * like strings, floats, and ints, to values the macro runtime (i.e. nodejs right now) can understand
 * and evaluate. If the entity is an identifier, we hopefully resolve it into something the runtime
 * can understand
 */
const getRuntimeValue = (expr: Expr | undefined): MacroRuntimeValue => {
  if (!expr) return undefined;

  if (isIdentifier(expr)) {
    const result = expr.resolveAsMacroEntity();
    if (result?.syntaxType !== "macro-variable") {
      throw new Error(
        `Macro entity cannot be resolved into runtime value, ${result}`
      );
    }
    return getRuntimeValue(result.value);
  }

  if (isFloat(expr) || isInt(expr) || isStringLiteral(expr)) {
    return expr.value;
  }

  throw new Error(
    `Macro entity cannot be resolved into runtime value, ${expr}`
  );
};

const defineVar = (opts: { args: List; parent: Expr; mut?: boolean }) => {
  const { args, parent, mut } = opts;
  // Warning: Cannot be typed like would be at compile time (for now);
  const identifier = args.at(0);
  const init = args.at(1);
  if (!isIdentifier(identifier) || !init) {
    throw new Error("Invalid variable");
  }
  const value = evalExpr(init);
  const variable = new MacroVariable({
    identifier,
    isMutable: !!mut,
    value,
    inherit: args,
  });
  parent.registerEntity(identifier, variable);
  return nop();
};

export type MacroRuntimeValue = string | number | undefined;
