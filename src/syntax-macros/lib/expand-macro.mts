import {
  Bool,
  Expr,
  Float,
  Identifier,
  Int,
  List,
  StringLiteral,
  isFloat,
  isIdentifier,
  isInt,
  isList,
  isStringLiteral,
} from "../../lib/index.mjs";
import { getIdStr } from "../../lib/syntax/get-id-str.mjs";
import { MacroLambda } from "../../lib/syntax/macro-lambda.mjs";
import { MacroVariable } from "../../lib/syntax/macro-variable.mjs";
import { Macro } from "../../lib/syntax/macros.mjs";

/** Expands a macro call */
export const expandMacro = (macro: Macro, call: List): Expr => {
  const clone = macro.clone();

  registerMacroVar({ with: clone, name: "&body", value: call.slice(1) });
  clone.parameters.forEach((name, index) => {
    registerMacroVar({ with: clone, name, value: call.at(index + 1)! });
  });

  return clone.body.map((exp) => evalExpr(exp)).at(-1) ?? nop();
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
  if (!isIdentifier(identifier)) return list;

  const idStr = getIdStr(identifier);
  const argsArr = fnsToSkipArgEval.has(idStr)
    ? list.rest()
    : list.rest().map(evalExpr);
  const args = new List({ value: argsArr, inherit: list });

  const func = functions[idStr];
  if (func) return func(args);

  const lambda = evalExpr(identifier);
  if (lambda.syntaxType === "macro-lambda") {
    return callLambda(lambda, args);
  }

  return list;
};

const callLambda = (lambda: MacroLambda, args: List): Expr => {
  const clone = lambda.clone();

  registerMacroVar({ with: clone, name: "&lambda", value: clone.clone() });
  clone.parameters.forEach((name, index) => {
    registerMacroVar({ with: clone, name, value: args.at(index)! });
  });

  return clone.body.map((exp) => evalExpr(exp)).at(-1) ?? nop();
};

type MacroFn = (args: List) => Expr;

const functions: Record<string, MacroFn | undefined> = {
  block: (args) => args.at(-1)!,
  length: (args) => (args.first()! as List).length,
  define: (args) => evalMacroVarDef(args.insert("define")),
  Identifier: (args) => {
    const nameDef = args.at(0);
    const name = isList(nameDef)
      ? (evalExpr(nameDef.at(2)!) as Identifier)
      : (nameDef as Identifier);
    return new Identifier({ value: name.value as string });
  },
  "=": (args) => {
    const identifier = args.first();
    if (!isIdentifier(identifier)) {
      throw new Error(`Expected identifier, got ${identifier}`);
    }

    const info = args.getParent()?.resolveMacroEntity(identifier);
    if (!info || info.syntaxType !== "macro-variable") {
      throw new Error(`Identifier ${identifier.value} is not defined`);
    }

    if (!info.isMutable) {
      throw new Error(`Variable ${identifier} is not mutable`);
    }

    info.value = evalExpr(args.at(1)!);
    return nop();
  },
  "==": (args) => bl(args, (l, r) => l === r),
  ">": (args) => bl(args, (l, r) => l > r),
  ">=": (args) => bl(args, (l, r) => l >= r),
  "<": (args) => bl(args, (l, r) => l < r),
  "<=": (args) => bl(args, (l, r) => l <= r),
  and: (args) => bl(args, (l, r) => !!(l && r)),
  or: (args) => bl(args, (l, r) => !(l || r)),
  not: (args) => bool(!getMacroTimeValue(args.first())),
  "+": (args) => ba(args, (l, r) => l + r),
  "-": (args) => ba(args, (l, r) => l - r),
  "*": (args) => ba(args, (l, r) => l * r),
  "/": (args) => ba(args, (l, r) => l / r),
  "lambda-expr": (args) => {
    const params = args.first();
    const body = args.at(1);

    if (!isList(params) || !isList(body)) {
      throw new Error("invalid lambda expression");
    }

    // For now, assumes params are untyped
    const parameters = params.value.map((p) => {
      if (!isIdentifier(p)) {
        throw new Error("Invalid lambda parameter");
      }

      return p;
    });

    return new MacroLambda({ parameters, body });
  },
  quote: (quote: List) => {
    const expand = (body: List): List =>
      body.reduce((exp) => {
        if (isList(exp) && exp.calls("$")) {
          return evalExpr(new List({ value: exp.rest(), parent: body }));
        }

        if (isList(exp) && exp.calls("$@")) {
          const rest = new List({ value: exp.rest(), parent: body });
          return (evalExpr(rest) as List).insert("splice-quote");
        }

        if (isList(exp)) return expand(exp);

        if (isIdentifier(exp) && exp.startsWith("$@")) {
          const value = evalIdentifier(exp.replace("$@", ""));
          if (!isList(value)) return nop();
          value.insert("splice-quote");
          return value;
        }

        if (isIdentifier(exp) && exp.startsWith("$")) {
          return evalIdentifier(exp.replace("$", ""));
        }

        return exp;
      });
    return expand(quote);
  },
  if: (args) => {
    const [condition, ifTrue, ifFalse] = args.value;

    if (!condition || !ifTrue) {
      console.log(JSON.stringify(args, undefined, 2));
      throw new Error("Invalid if expr");
    }

    const condResult = evalExpr(handleOptionalConditionParenthesis(condition));

    if (getMacroTimeValue(condResult)) {
      return evalExpr(ifTrue);
    }

    if (ifFalse) {
      return evalExpr(ifFalse);
    }

    return nop();
  },
  array: (args) => args,
  slice: (args) => {
    const list = args.first()! as List;
    const start = getMacroTimeValue(args.at(1)) as number | undefined;
    const end = getMacroTimeValue(args.at(2)) as number | undefined;
    return list.slice(start, end);
  },
  extract: (args) => {
    const list = args.first()! as List;
    const index = getMacroTimeValue(args.at(1)) as number;
    return list.at(index)!; // TODO: Make this safer
  },
  map: (args) => {
    const list = args.first()! as List;
    const lambda = args.at(1)! as MacroLambda;
    return list.map((val, index, array) => {
      const lambdaArgs = new List({
        value: [val, new Int({ value: index }), new List({ value: array })],
      });
      return callLambda(lambda, lambdaArgs);
    });
  },
  reduce: (args) => {
    const list = args.at(0)! as List;
    const start = args.at(1)!;
    const lambda = args.at(2)! as MacroLambda;
    return list.value.reduce((prev, cur, index, array) => {
      const args = new List({
        value: [
          prev,
          cur,
          new Int({ value: index }),
          new List({ value: array }),
        ],
      });
      return callLambda(lambda, args);
    }, evalExpr(start));
  },
  push: (args) => {
    const list = args.at(0) as List;
    const val = args.at(1)!;
    return list.push(val);
  },
  spread: (args) => {
    const list = args.at(0) as List;
    const val = args.at(1)! as List;
    return list.push(...val.value);
  },
  concat: (args) => {
    const list = args.first() as List;
    return list.push(...args.rest().flatMap((expr) => (expr as List).value));
  },
  "is-list": (args) => bool(isList(args.at(0))),
  log: (arg) => {
    console.error(JSON.stringify(arg.first(), undefined, 2));
    return arg;
  },
  split: (args) => {
    const str = args.at(0) as StringLiteral;
    const splitter = args.at(0) as StringLiteral;
    return new List({ value: str.value.split(splitter.value), inherit: args });
  },
  "macro-expand": (args) => evalExpr(args.at(0)!),
  "char-to-code": (args) =>
    new Int({
      value: String((args.at(0) as StringLiteral).value).charCodeAt(0),
    }),
};

const fnsToSkipArgEval = new Set(["if", "quote", "lambda-expr", "define", "="]);

const handleOptionalConditionParenthesis = (expr: Expr): Expr => {
  if (isList(expr) && isList(expr.first())) {
    return expr.first()!;
  }

  return expr;
};

const nop = () => new List({}).push(Identifier.from("splice-quote"));

/** Binary logical comparison */
const bl = (args: List, fn: (l: any, r: any) => boolean) => {
  // TODO Assertions / validation
  return bool(
    fn(getMacroTimeValue(args.at(0))!, getMacroTimeValue(args.at(1))!)
  );
};

/** Binary arithmetic operation */
const ba = (args: List, fn: (l: number, r: number) => number) => {
  const left = args.at(0);
  const right = args.at(1);
  // TODO Assertions / validation
  const value = fn(
    getMacroTimeValue(left) as number,
    getMacroTimeValue(right) as number
  );

  const isRtInt =
    typeof value === "number" && isInt(left) && isInt(right) && value % 1 === 0;

  if (isRtInt) {
    return new Int({ value });
  }

  // TODO Only allow numbers here. Yucky. What was I thinking, concatenating strings with +
  if (typeof value === "string") {
    return new StringLiteral({ value });
  }

  if (typeof value === "undefined") {
    throw new Error(`Invalid macro binary arithmetic expression ${args}`);
  }

  return new Float({ value });
};

const bool = (b: boolean) => new Bool({ value: b });

const getMacroTimeValue = (expr: Expr | undefined): any => {
  if (!expr) return undefined;

  if (isIdentifier(expr)) {
    const result = expr.resolveAsMacroEntity();
    if (result?.syntaxType !== "macro-variable") {
      throw new Error(
        `Macro entity cannot be resolved into macro time value, ${result}`
      );
    }
    return getMacroTimeValue(result.value);
  }

  if (isFloat(expr) || isInt(expr) || isStringLiteral(expr)) {
    return expr.value;
  }

  throw new Error(
    `Macro entity cannot be resolved into macro time value, ${expr}`
  );
};

const registerMacroVar = (opts: {
  with: Expr;
  name: string | Identifier;
  value: Expr;
  isMut?: boolean;
}) => {
  opts.with.registerEntity(
    opts.name,
    new MacroVariable({
      identifier: isIdentifier(opts.name)
        ? opts.name
        : Identifier.from(opts.name),
      value: opts.value,
      isMutable: !!opts.isMut,
    })
  );
};

export const evalMacroVarDef = (call: List) => {
  // Warning: Cannot be typed like would be at compile time (for now);
  const identifier = call.at(1);
  const mut = call.at(2) as Bool;
  const init = call.at(3);
  if (!isIdentifier(identifier) || !init) {
    throw new Error("Invalid variable");
  }

  return new MacroVariable({
    identifier,
    isMutable: mut.value,
    value: evalExpr(init),
    inherit: call,
  });
};
