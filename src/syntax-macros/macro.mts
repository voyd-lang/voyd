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

const evalExpr = (expr: Expr): Expr => {
  if (!isList(expr)) return expr;
  if (expr.calls("pub")) return evalPubList(expr);
  if (expr.calls("macro")) return evalMacroDef(expr);
  if (expr.calls("macro-let")) return evalMacroLetDef(expr);

  const identifier = expr.first();
  if (!isIdentifier(identifier)) {
    return expr.map(evalExpr);
  }

  const macro = identifier.resolveAsMacroEntity();
  if (macro?.syntaxType === "macro") {
    return evalExpr(expandMacro({ macro, call: expr }));
  }

  return expr.map(evalExpr);
};

const evalPubList = (list: List) => {
  const value = evalExpr(list.slice(1));
  if (value.syntaxType === "macro") {
    list.getParent()?.registerEntity(value.identifier, value);
  }

  if (value.syntaxType === "macro-variable") {
    list.getParent()?.registerEntity(value.identifier, value);
  }

  return new List({ value: ["export", value] });
};

const evalMacroDef = (list: List) => {
  const macro = listToMacro(list);
  list.getParent()?.registerEntity(macro.identifier, macro);
  return macro;
};

const evalMacroLetDef = (list: List) => {
  return defineVar({
    args: list.slice(1),
    mut: false,
    parent: list.getParent()!,
  });
};

const evalMacroExpr = (expr: Expr) => {
  if (isIdentifier(expr)) return evalMacroIdentifier(expr);
  if (!isList(expr)) return expr;
  return evalMacroList(expr);
};

const evalMacroIdentifier = (expr: Identifier): Expr => {
  const entity = expr.resolveAsMacroEntity();
  if (!entity) return expr;
  if (entity.syntaxType !== "macro-variable") return expr;
  if (!entity.value) return expr;
  return entity.value;
};

const evalMacroList = (list: List): Expr => {
  const identifier = list.first();
  if (!isIdentifier(identifier)) {
    return list.map(evalMacroExpr);
  }

  const idStr = getIdStr(identifier);
  // TODO consider skipping args for built in functions no matter what, and only evaluate args for lambda calls
  const shouldSkipArgEval = fnsToSkipArgEval.has(idStr);
  const argsArr = !shouldSkipArgEval
    ? list.rest().map(evalMacroExpr)
    : list.rest();
  const args = new List({ value: argsArr, parent: list.getParent() });

  const stdFn = functions[idStr];
  if (stdFn) {
    return stdFn({ identifier, parent: list.getParent() ?? list }, args);
  }

  const entity = identifier.resolveAsMacroEntity();
  if (!entity) {
    return list.map(evalMacroExpr);
  }

  if (entity.syntaxType === "macro") {
    const expanded = expandMacro({ macro: entity, call: list });
    return evalMacroExpr(expanded);
  }

  const value = entity.value;
  if (!value) {
    return list.map(evalMacroExpr);
  }

  if (value.syntaxType === "macro-lambda") {
    return callLambda({ lambda: value, args });
  }

  return list.map(evalMacroExpr);
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

  return clone.body.map((exp) => evalMacroExpr(exp)).at(-1) ?? nop();
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

  return clone.body.map((exp) => evalMacroExpr(exp)).at(-1) ?? nop();
};

type FnOpts = {
  parent: Expr;
  identifier: Identifier;
};

const functions: Record<
  string,
  ((opts: FnOpts, args: List) => Expr) | undefined
> = {
  block: (_, args) => args.at(-1)!,
  length: (_, args) => (args.first()! as List).length,
  define: ({ parent }, args) => defineVar({ args, parent }),
  Identifier: (_, args) => {
    const nameDef = args.at(0);
    const name = isList(nameDef)
      ? (evalMacroExpr(nameDef.at(2)!) as Identifier)
      : (nameDef as Identifier);
    return new Identifier({ value: name.value as string });
  },
  "=": ({ parent }, args) => {
    const identifier = args.first();
    if (!isIdentifier(identifier)) {
      throw new Error(`Expected identifier, got ${identifier}`);
    }

    const info = parent.resolveMacroEntity(identifier);
    if (!info || info.syntaxType !== "macro-variable") {
      throw new Error(`Identifier ${identifier.value} is not defined`);
    }

    if (!info.isMutable) {
      throw new Error(`Variable ${identifier} is not mutable`);
    }

    info.value = evalMacroExpr(args.at(1)!);
    return nop();
  },
  "==": (_, args) => bl(args, (l, r) => l === r),
  ">": (_, args) => bl(args, (l, r) => l > r),
  ">=": (_, args) => bl(args, (l, r) => l >= r),
  "<": (_, args) => bl(args, (l, r) => l < r),
  "<=": (_, args) => bl(args, (l, r) => l <= r),
  and: (_, args) => bl(args, (l, r) => !!(l && r)),
  or: (_, args) => bl(args, (l, r) => !(l || r)),
  not: (_, args) => bool(!getMacroTimeValue(args.first())),
  "+": (_, args) => ba(args, (l, r) => l + r),
  "-": (_, args) => ba(args, (l, r) => l - r),
  "*": (_, args) => ba(args, (l, r) => l * r),
  "/": (_, args) => ba(args, (l, r) => l / r),
  "lambda-expr": ({ parent }, args) => {
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
  quote: (_, quote: List) => {
    const expand = (body: List): List =>
      body.reduce((exp) => {
        if (isList(exp) && exp.calls("$")) {
          return evalMacroExpr(new List({ value: exp.rest(), parent: body }));
        }

        if (isList(exp) && exp.calls("$@")) {
          const rest = new List({ value: exp.rest(), parent: body });
          return (evalMacroExpr(rest) as List).insert("splice-quote");
        }

        if (isList(exp)) return expand(exp);

        if (isIdentifier(exp) && exp.value.startsWith("$@")) {
          const id = exp.value.replace("$@", "");
          const entity = exp.resolveMacroEntity(id);
          if (entity?.syntaxType === "macro-variable") {
            const list = entity.value as List;
            list.insert("splice-quote");
            return list;
          }
          return nop();
        }

        if (isIdentifier(exp) && exp.value.startsWith("$")) {
          const id = exp.value.replace("$", "");
          const entity = exp.resolveMacroEntity(id);
          if (entity?.syntaxType === "macro-variable") {
            return entity.value!;
          }
          return nop();
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

    const condResult = evalMacroExpr(
      handleOptionalConditionParenthesis(condition)
    );

    if (getMacroTimeValue(condResult)) {
      return evalMacroExpr(ifTrue);
    }

    if (ifFalse) {
      return evalMacroExpr(ifFalse);
    }

    return nop();
  },
  array: (_, args) => args,
  slice: (_, args) => {
    const list = args.first()! as List;
    const start = getMacroTimeValue(args.at(1)) as number | undefined;
    const end = getMacroTimeValue(args.at(2)) as number | undefined;
    return list.slice(start, end);
  },
  extract: (_, args) => {
    const list = args.first()! as List;
    const index = getMacroTimeValue(args.at(1)) as number;
    return list.at(index)!; // TODO: Make this safer
  },
  map: ({ parent }, args) => {
    const list = args.first()! as List;
    const lambda = args.at(1)! as MacroLambda;
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
    const lambda = args.at(2)! as MacroLambda;
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
      evalMacroExpr(start)
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
  "macro-expand": (_, args) => evalMacroExpr(args.at(0)!),
  "char-to-code": (_, args) =>
    new Int({
      value: String((args.at(0) as StringLiteral).value).charCodeAt(0),
    }),
};

const fnsToSkipArgEval = new Set([
  "if",
  "quote",
  "lambda-expr",
  "root",
  "module",
  "define",
  "define-mut",
  "define-global",
  "define-mut-global",
  "define-function",
  "define-macro-var",
  "define-mut-macro-var",
  "=",
]);

const handleOptionalConditionParenthesis = (expr: Expr): Expr => {
  if (isList(expr) && isList(expr.first())) {
    return expr.first()!;
  }

  return expr;
};

/** Slice out the beginning macro before calling */
const listToMacro = (list: List): Macro => {
  // TODO Assertions?
  const signature = list.first() as List;
  const identifier = signature.first() as Identifier;
  const parameters = signature.rest() as Identifier[];
  const body = list.slice(1).map(evalExpr);
  const macro = new RegularMacro({
    inherit: list,
    identifier,
    parameters,
    body,
  });
  return macro;
};

const nop = () => new List({}).push(Identifier.from("splice-quote"));

/** Binary logical comparison */
const bl = (
  args: List,
  fn: (l: MacroRuntimeValue, r: MacroRuntimeValue) => boolean
) => {
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

const getMacroTimeValue = (
  expr: Expr | undefined
): MacroRuntimeValue | undefined => {
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

const defineVar = (opts: { args: List; parent: Expr; mut?: boolean }) => {
  const { args, parent, mut } = opts;
  // Warning: Cannot be typed like would be at compile time (for now);
  const identifier = args.at(0);
  const init = args.at(1);
  if (!isIdentifier(identifier) || !init) {
    throw new Error("Invalid variable");
  }
  const value = evalMacroExpr(init);
  const variable = new MacroVariable({
    identifier,
    isMutable: !!mut,
    value,
    inherit: args,
  });
  parent.registerEntity(identifier, variable);
  return variable;
};

export type MacroRuntimeValue = string | number;
