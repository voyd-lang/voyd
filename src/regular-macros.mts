import { getIdStr } from "./syntax-objects/get-id-str.mjs";
import {
  Bool,
  Expr,
  Float,
  Identifier,
  Int,
  List,
  StringLiteral,
  MacroLambda,
  Macro,
  RegularMacro,
  MacroVariable,
  VoidModule,
} from "./syntax-objects/index.mjs";
import { NamedEntity } from "./syntax-objects/named-entity.mjs";

export const expandRegularMacros = (expr: Expr): Expr => {
  if (expr.isModule()) return expandModuleMacros(expr);
  if (!expr.isList()) return expr;
  if (expr.calls("use")) return resolveUseStatement(expr);
  if (expr.calls("export")) return evalExport(expr);
  if (expr.calls("macro")) return evalMacroDef(expr);
  if (expr.calls("macro-let")) return evalMacroLetDef(expr);

  const identifier = expr.first();
  if (!identifier?.isIdentifier()) {
    return expr.map(expandRegularMacros);
  }

  const macro = identifier.resolve();
  if (macro?.isMacro()) {
    const after = expandRegularMacros(expandMacro(macro, expr));
    return after;
  }

  return expr.map(expandRegularMacros);
};

const expandModuleMacros = (module: VoidModule): VoidModule => {
  if (module.phase > 0) return module;
  module.phase = 1;
  module.applyMap((expr) => expandRegularMacros(expr));
  module.phase = 2;
  return module;
};

const resolveUseStatement = (list: List) => {
  const path = list.listAt(1);
  const entities = resolveUsePath(path);
  if (entities instanceof Array) {
    entities.forEach((e) => list.parent?.registerEntity(e));
  } else {
    list.parent?.registerEntity(entities);
  }
  return list;
};

const resolveUsePath = (path: List): NamedEntity | NamedEntity[] => {
  if (!path.calls("::")) {
    throw new Error(
      `Invalid use statement ${console.log(JSON.stringify(path, undefined, 2))}`
    );
  }

  const [_, left, right] = path.value;
  const unexpandedModule = left?.isList()
    ? resolveUsePath(left)
    : left?.isIdentifier()
    ? resolveUseIdentifier(left)
    : undefined;

  if (
    !unexpandedModule ||
    unexpandedModule instanceof Array ||
    !unexpandedModule.isModule()
  ) {
    // This is caused by pushChildModule which clones the module and stores the wrong one.
    throw new Error(
      `Invalid use statement, not a module ${console.log(
        JSON.stringify(path, undefined, 2)
      )}`
    );
  }

  const module = expandModuleMacros(unexpandedModule);
  const identifier = right as Identifier;

  if (!identifier?.isIdentifier()) {
    throw new Error(`Invalid use statement, expected identifier, got ${right}`);
  }

  if (identifier?.is("***")) {
    return module.getAllEntities().filter((e) => e.isExported);
  }

  const entity = module.resolveChildEntity(right as Identifier);
  if (!entity) {
    throw new Error(
      `Invalid use statement, macro ${right} not found in module ${module}`
    );
  }

  if (!entity.isExported) {
    throw new Error(`Invalid use statement, entity ${right} is not exported`);
  }

  return entity;
};

const resolveUseIdentifier = (identifier: Identifier) => {
  if (identifier.is("super")) {
    return identifier.parentModule?.parentModule;
  }

  return identifier.resolve();
};

const evalExport = (list: List) => {
  const block = list.listAt(1); // export is expected to be passed a block

  const expandedBlock = block.map((exp) => {
    const expanded = expandRegularMacros(exp);
    if (expanded.isMacro()) {
      list.parent?.registerEntity(expanded);
    }

    if (expanded.isMacroVariable()) {
      list.parent?.registerEntity(expanded);
    }

    return expanded;
  });

  list.set(1, expandedBlock);
  return list;
};

const evalMacroDef = (list: List) => {
  const macro = listToMacro(list);
  list.parent?.registerEntity(macro);
  return macro;
};

const evalMacroLetDef = (list: List) => {
  const expanded = expandRegularMacros(list.set(0, "let")) as List;
  return evalMacroVarDef(expanded);
};

/** Slice out the beginning macro before calling */
const listToMacro = (list: List): Macro => {
  const signature = list.listAt(1);
  const name = signature.identifierAt(0);
  const parameters = signature.rest() as Identifier[];
  const body = list.slice(2).map(expandRegularMacros).insert("block");
  const macro = new RegularMacro({
    ...list.context,
    name,
    parameters,
    body,
  });
  return macro;
};

/** Expands a macro call */
export const expandMacro = (macro: Macro, call: List): Expr => {
  const clone = macro.clone();

  registerMacroVar({ with: clone, name: "&body", value: call.slice(1) });
  clone.parameters.forEach((name, index) => {
    registerMacroVar({ with: clone, name, value: call.at(index + 1)! });
  });

  return clone.body.map((exp) => evalMacroExpr(exp)).at(-1) ?? nop();
};

const evalMacroExpr = (expr: Expr) => {
  if (expr.isIdentifier()) return evalIdentifier(expr);
  if (!expr.isList()) return expr;
  return evalMacroTimeFnCall(expr);
};

const evalIdentifier = (expr: Identifier): Expr => {
  const entity = expr.resolve();
  if (!entity) return expr;
  if (!entity.isMacroVariable()) return expr;
  if (!entity.value) return expr;
  return entity.value;
};

const evalMacroTimeFnCall = (list: List): Expr => {
  const identifier = list.first();
  if (!identifier?.isIdentifier()) return list;

  const idStr = getIdStr(identifier);
  const argsArr = fnsToSkipArgEval.has(idStr)
    ? list.rest()
    : list.rest().map(evalMacroExpr);
  const args = (() => {
    try {
      return new List({ ...list.context, value: argsArr });
    } catch (error) {
      throw error;
    }
  })();

  const func = functions[idStr];
  if (func) return func(args);

  const lambda = evalMacroExpr(identifier);
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

  return clone.body.map((exp) => evalMacroExpr(exp)).at(-1) ?? nop();
};

type MacroFn = (args: List) => Expr;

const functions: Record<string, MacroFn | undefined> = {
  block: (args) => args.at(-1)!,
  length: (args) => args.listAt(0).length,
  define: (args) => evalMacroVarDef(args.insert("define")),
  Identifier: (args) => {
    const nameDef = args.at(0);
    const name = nameDef?.isList()
      ? (evalMacroExpr(nameDef.identifierAt(2)) as Identifier)
      : (nameDef as Identifier);
    return new Identifier({ value: name.value as string });
  },
  "=": (args) => {
    const identifier = args.first();
    if (!identifier?.isIdentifier()) {
      throw new Error(`Expected identifier, got ${identifier}`);
    }

    const info = args.parent?.resolveEntity(identifier);
    if (!info || !info.isMacroVariable()) {
      throw new Error(`Identifier ${identifier.value} is not defined`);
    }

    if (!info.isMutable) {
      throw new Error(`Variable ${identifier} is not mutable`);
    }

    info.value = evalMacroExpr(args.at(1)!);
    return nop();
  },
  ":": (args) => args.at(1) ?? nop(),
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
  "=>": (args) => {
    const params = args.first();
    const body = args.at(1);

    if (!params?.isList() || !body?.isList()) {
      throw new Error("invalid lambda expression");
    }

    // For now, assumes params are untyped
    const parameters = params.value.map((p) => {
      if (!p.isIdentifier()) {
        throw new Error("Invalid lambda parameter");
      }

      return p;
    });

    return new MacroLambda({ parameters, body });
  },
  quote: (quote: List) => {
    const expand = (body: List): List =>
      body.reduce((exp) => {
        if (exp.isList() && exp.calls("$")) {
          return evalMacroExpr(new List({ value: exp.rest(), parent: body }));
        }

        if (exp.isList() && exp.calls("$@")) {
          const rest = new List({ value: exp.rest(), parent: body });
          return (evalMacroExpr(rest) as List).insert("splice-quote");
        }

        if (exp.isList()) return expand(exp);

        if (exp.isIdentifier() && exp.startsWith("$@")) {
          const value = evalIdentifier(exp.replace("$@", ""));
          if (!value.isList()) return nop();
          value.insert("splice-quote");
          return value;
        }

        if (exp.isIdentifier() && exp.startsWith("$")) {
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
  array: (args) => args,
  slice: (args) => {
    const list = args.listAt(0);
    const start = getMacroTimeValue(args.at(1)) as number | undefined;
    const end = getMacroTimeValue(args.at(2)) as number | undefined;
    return list.slice(start, end);
  },
  extract: (args) => {
    const list = args.listAt(0);
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
    }, evalMacroExpr(start));
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
  "is-list": (args) => bool(!!args.at(0)?.isList()),
  log: (arg) => {
    console.error(JSON.stringify(arg.first(), undefined, 2));
    return arg;
  },
  split: (args) => {
    const str = args.at(0) as StringLiteral;
    const splitter = args.at(0) as StringLiteral;
    return new List({
      value: str.value.split(splitter.value),
      ...args.context,
    });
  },
  "expand-macros": (args) => expandRegularMacros(args.at(0)!),
  "char-to-code": (args) =>
    new Int({
      value: String((args.at(0) as StringLiteral).value).charCodeAt(0),
    }),
};

const fnsToSkipArgEval = new Set(["if", "quote", "=>", "define", "="]);

const handleOptionalConditionParenthesis = (expr: Expr): Expr => {
  if (expr.isList() && expr.first()?.isList()) {
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
    typeof value === "number" &&
    left?.isInt() &&
    right?.isInt() &&
    value % 1 === 0;

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

  if (expr.isIdentifier()) {
    const result = expr.resolve();
    if (!result?.isMacroVariable()) {
      throw new Error(
        `Macro entity cannot be resolved into macro time value, ${result}`
      );
    }
    return getMacroTimeValue(result.value);
  }

  if (expr.isFloat() || expr.isInt() || expr.isStringLiteral()) {
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
  const { name, value, isMut } = opts;
  const variable = new MacroVariable({ name, value, isMutable: !!isMut });
  opts.with.registerEntity(variable);
};

export const evalMacroVarDef = (call: List) => {
  const isMutable = call.calls("define-mut");

  const identifier = call.at(1);
  const init = call.at(2);
  if (!identifier?.isIdentifier() || !init) {
    throw new Error("Invalid variable");
  }

  const variable = new MacroVariable({
    ...identifier.context,
    name: identifier,
    isMutable,
    value: evalMacroExpr(init),
  });
  call.parent?.registerEntity(variable);
  return variable;
};
