import { Form } from "../../ast/form.js";
import {
  Expr,
  IdentifierAtom,
  InternalIdentifierAtom,
  isBoolAtom,
  isFloatAtom,
  isForm,
  isIdentifierAtom,
  isIntAtom,
  isStringAtom,
} from "../../ast/index.js";
import { getSyntaxId } from "../../ast/syntax.js";
import { parseStringValue } from "../string-value.js";
import type { MacroScope } from "./scope.js";
import {
  bool,
  cloneExpr,
  cloneMacroEvalResult,
  createFloat,
  createInt,
  expectExpr,
  expectForm,
  expectIdentifier,
} from "./helpers.js";
import { nextMacroId } from "./macro-id.js";
import type {
  BuiltinContext,
  BuiltinFn,
  EvalOpts,
  MacroEvalResult,
  MacroLambdaValue,
} from "./types.js";
import { isMacroLambdaValue } from "./types.js";

export type BuiltinsDeps = {
  evalMacroExpr: (
    expr: Expr,
    scope: MacroScope,
    opts?: EvalOpts,
  ) => MacroEvalResult;
  callLambda: (lambda: MacroLambdaValue, args: Expr[]) => MacroEvalResult;
};

export const fnsToSkipArgEval = new Set([
  "if",
  "let",
  "syntax_template",
  "`",
  "=>",
  "define",
  "=",
]);

export const createBuiltins = (
  deps: BuiltinsDeps,
): Record<string, BuiltinFn | undefined> => {
  const { evalMacroExpr, callLambda } = deps;

  const getMacroTimeValue = (
    expr: Expr | MacroEvalResult | undefined,
    scope: MacroScope,
  ): any => {
    if (!expr) return undefined;

    if (isMacroLambdaValue(expr)) return expr;

    if (isIdentifierAtom(expr)) {
      const binding = scope.getVariable(expr.value);
      if (binding) {
        return getMacroTimeValue(binding.value, scope);
      }
      return expr.value;
    }

    if (isIntAtom(expr) || isFloatAtom(expr)) {
      return Number(expr.value);
    }

    if (isBoolAtom(expr)) {
      return expr.value === "true";
    }

    if (isStringAtom(expr)) {
      return expr.value;
    }

    if (isForm(expr)) {
      return expr.toArray();
    }

    return expr;
  };

  const evaluateMacroValue = (
    expr: Expr | undefined,
    scope: MacroScope,
  ): unknown => {
    if (!expr) return undefined;
    const evaluated = evalMacroExpr(cloneExpr(expr), scope);
    return getMacroTimeValue(evaluated, scope);
  };

  const binaryLogic = (
    { originalArgs, scope }: BuiltinContext,
    fn: (l: any, r: any) => boolean,
  ): boolean => {
    const left = evaluateMacroValue(originalArgs.at(0), scope);
    const right = evaluateMacroValue(originalArgs.at(1), scope);
    return fn(left, right);
  };

  const arithmetic = (
    { originalArgs, scope }: BuiltinContext,
    fn: (l: number, r: number) => number | string,
  ): Expr => {
    const evaluatedLeft = evaluateMacroValue(originalArgs.at(0), scope);
    const evaluatedRight = evaluateMacroValue(originalArgs.at(1), scope);
    const left = Number(evaluatedLeft);
    const right = Number(evaluatedRight);
    const value = fn(left, right);

    if (typeof value === "number") {
      return Number.isInteger(value) ? createInt(value) : createFloat(value);
    }

    const identifier = new IdentifierAtom(value);
    identifier.setIsQuoted(true);
    return identifier;
  };

  const normalizeLambdaParameters = (expr?: Expr): IdentifierAtom[] => {
    if (!expr) return [];
    if (isIdentifierAtom(expr)) return [expr.clone()];
    if (!isForm(expr)) {
      throw new Error("Invalid lambda parameter list");
    }

    const elements = expr.toArray();
    if (elements.length && isIdentifierAtom(elements[0])) {
      if (elements[0]!.value === "parameters") {
        return elements
          .slice(1)
          .map((item, index) =>
            expectIdentifier(item, `lambda parameter ${index + 1}`),
          )
          .map((identifier) => identifier.clone());
      }
    }
    if (
      elements.length &&
      isIdentifierAtom(elements[0]) &&
      elements[0].value === "tuple"
    ) {
      return elements
        .slice(1)
        .map((item, index) =>
          expectIdentifier(item, `lambda tuple parameter ${index + 1}`),
        )
        .map((identifier) => identifier.clone());
    }

    return elements.map((item, index) =>
      expectIdentifier(item, `lambda parameter ${index + 1}`),
    );
  };

  const normalizeLambdaBody = (expr: Expr): Expr[] => {
    if (isForm(expr) && expr.calls("block")) {
      return expr.toArray().slice(1);
    }
    return [expr];
  };

  const expandSyntaxTemplate = (args: Expr[], scope: MacroScope): Expr[] => {
    const expand = (exprs: Expr[]): Expr[] =>
      exprs.flatMap((expr) => {
        if (isForm(expr) && isIdentifierAtom(expr.at(0))) {
          if (expr.calls("$$")) {
            const value = expr.at(1) ?? new IdentifierAtom("nop");
            const evaluated = evalMacroExpr(value, scope, {
              skipBuiltins: new Set([":"]),
            });
            const normalized = expectExpr(evaluated);
            return isForm(normalized)
              ? normalized.toArray().map(cloneExpr)
              : [cloneExpr(normalized)];
          }

          if (expr.calls("$")) {
            const value = expr.at(1) ?? new IdentifierAtom("nop");
            return [expectExpr(evalMacroExpr(value, scope))];
          }
        }

        if (isIdentifierAtom(expr)) {
          if (expr.value.startsWith("$$")) {
            const identifier = new IdentifierAtom(expr.value.slice(2));
            const evaluated = evalMacroExpr(identifier, scope);
            const normalized = expectExpr(evaluated);
            return isForm(normalized)
              ? normalized.toArray().map(cloneExpr)
              : [cloneExpr(normalized)];
          }

          if (expr.value.startsWith("$")) {
            const identifier = new IdentifierAtom(expr.value.slice(1));
            const evaluated = evalMacroExpr(identifier, scope);
            return [expectExpr(evaluated)];
          }
        }

        if (isForm(expr)) {
          const expanded = expand(expr.toArray());
          return [new Form(expanded.map((item) => cloneExpr(item)))];
        }

        return expr;
      });

    return expand(args);
  };

  const handleOptionalConditionParenthesis = (expr: Expr): Expr => {
    if (isForm(expr) && isForm(expr.at(0))) {
      return expr.at(0)!;
    }
    return expr;
  };

  const collectFormLabels = (form: Form, label: string): Expr[] => {
    const args = form.toArray().slice(1);
    const result: Expr[] = [];
    args.forEach((expression) => {
      if (!isForm(expression)) return;
      if (!expression.calls(":")) return;
      const labelExpr = expression.at(1);
      if (!isIdentifierAtom(labelExpr)) return;
      if (labelExpr.value === label) {
        const value = expression.at(2);
        if (value) result.push(value);
      }
    });
    return result;
  };

  const getOptionalFormLabel = (
    form: Form,
    label: string,
  ): Expr | undefined => {
    const args = collectFormLabels(form, label);
    return args.at(0);
  };

  const expectFormLabel = (form: Form, label: string): Expr => {
    const args = collectFormLabels(form, label);
    const labelExpr = args.at(0);
    if (!labelExpr) throw new Error(`Labeled argument '${label}' not found`);
    return labelExpr;
  };

  const resolveForm = (
    evaluated: MacroEvalResult | undefined,
    original: Expr | undefined,
    scope: MacroScope,
    context: string,
  ): Form => {
    if (evaluated) {
      const expr =
        evaluated instanceof Form ? evaluated : expectExpr(evaluated);
      if (isForm(expr)) return expr;
    }

    if (original) {
      const result = evalMacroExpr(cloneExpr(original), scope);
      const expr = expectExpr(result);
      if (isForm(expr)) return expr;
    }

    throw new Error(`Expected form for ${context}`);
  };

  const syntaxTemplateBuiltin: BuiltinFn = ({ originalArgs, scope }) => {
    const expanded = expandSyntaxTemplate(originalArgs, scope);
    if (expanded.length === 1) return cloneExpr(expanded[0]!);
    return new Form(expanded.map(cloneExpr));
  };

  return {
    block: ({ args }) => {
      const value = args.at(-1);
      return value
        ? expectExpr(value, "block result")
        : new IdentifierAtom("nop");
    },
    emit_many: ({ args }) => {
      const values = args.map((arg) => expectExpr(arg, "emit_many value"));
      const single = values.at(0);
      const flattened =
        values.length === 1 &&
        isForm(single) &&
        (single.length === 0 || single.toArray().every((entry) => isForm(entry)))
          ? single.toArray()
          : values;
      return new Form([
        new InternalIdentifierAtom("emit_many"),
        ...flattened.map((value) => cloneExpr(value)),
      ]);
    },
    empty_list: () => new Form([]),
    panic: ({ args, originalArgs, scope }) => {
      const messageExpr = args.at(0);
      if (!messageExpr) {
        throw new Error("panic requires a message");
      }
      const parsedMessage = parseStringValue(originalArgs.at(0));
      if (parsedMessage !== null) {
        throw new Error(parsedMessage);
      }
      const value = getMacroTimeValue(messageExpr, scope);
      const message =
        typeof value === "string" ? value : JSON.stringify(value ?? "panic");
      throw new Error(message);
    },
    length: ({ args }) => {
      const list = expectForm(args.at(0), "length target");
      return createInt(list.length);
    },
    define: ({ originalArgs, scope }) => {
      const identifier = expectIdentifier(originalArgs.at(0), "define target");
      const value = evalMacroExpr(cloneExpr(originalArgs.at(1)!), scope);
      scope.defineVariable({
        name: identifier.clone(),
        value: cloneMacroEvalResult(value),
        mutable: false,
      });
      return new IdentifierAtom("nop");
    },
    let: ({ originalArgs, scope }) => {
      const assignment = expectForm(originalArgs.at(0), "let assignment");
      const operator = assignment.at(0);
      if (!isIdentifierAtom(operator) || operator.value !== "=") {
        throw new Error("let expects an assignment expression");
      }
      const identifier = expectIdentifier(assignment.at(1), "let identifier");
      const valueExpr = assignment.at(2);
      if (!valueExpr) {
        throw new Error("let requires an initializer");
      }
      const value = evalMacroExpr(cloneExpr(valueExpr), scope);
      scope.defineVariable({
        name: identifier.clone(),
        value: cloneMacroEvalResult(value),
        mutable: false,
      });
      return new IdentifierAtom("nop");
    },
    "=": ({ originalArgs, scope }) => {
      const identifier = expectIdentifier(
        originalArgs.at(0),
        "assignment target",
      );
      const value = evalMacroExpr(cloneExpr(originalArgs.at(1)!), scope);
      scope.assignVariable(identifier.value, cloneMacroEvalResult(value));
      return new IdentifierAtom("nop");
    },
    ":": ({ args }) => {
      const value = args.at(1);
      return value
        ? expectExpr(value, "label value")
        : new IdentifierAtom("nop");
    },
    "==": (ctx) => bool(binaryLogic(ctx, (l, r) => l === r)),
    ">": (ctx) => bool(binaryLogic(ctx, (l, r) => l > r)),
    ">=": (ctx) => bool(binaryLogic(ctx, (l, r) => l >= r)),
    "<": (ctx) => bool(binaryLogic(ctx, (l, r) => l < r)),
    "<=": (ctx) => bool(binaryLogic(ctx, (l, r) => l <= r)),
    and: (ctx) => bool(binaryLogic(ctx, (l, r) => Boolean(l && r))),
    or: (ctx) => bool(binaryLogic(ctx, (l, r) => Boolean(l || r))),
    not: ({ args, scope }) => {
      const value = getMacroTimeValue(args.at(0), scope);
      return bool(!value);
    },
    "+": (ctx) => arithmetic(ctx, (l, r) => l + r),
    "-": (ctx) => arithmetic(ctx, (l, r) => l - r),
    "*": (ctx) => arithmetic(ctx, (l, r) => l * r),
    "/": (ctx) => arithmetic(ctx, (l, r) => l / r),
    "=>": ({ originalArgs, scope }) => {
      const paramsExpr = originalArgs.at(0);
      const bodyExpr = originalArgs.at(1);
      if (!bodyExpr) throw new Error("Lambda requires a body");

      const parameters = normalizeLambdaParameters(paramsExpr);
      const body = normalizeLambdaBody(bodyExpr).map((expr) => cloneExpr(expr));

      return {
        kind: "macro-lambda",
        parameters,
        body,
        scope,
        id: new IdentifierAtom(`lambda#${nextMacroId()}`),
      } satisfies MacroLambdaValue;
    },
    calls: ({ args }) => {
      const call = expectForm(args.at(0), "calls target");
      const label = expectIdentifier(args.at(1), "calls identifier");
      const target = call.at(0);
      if (!isIdentifierAtom(target) && !(target instanceof InternalIdentifierAtom)) {
        return bool(false);
      }
      return bool(target.value === label.value);
    },
    argWithLabel: ({ args }) => {
      const call = expectForm(args.at(0), "argWithLabel call");
      const label = expectIdentifier(args.at(1), "argWithLabel label");
      return cloneExpr(expectFormLabel(call, label.value));
    },
    optionalArgWithLabel: ({ args }) => {
      const call = expectForm(args.at(0), "optionalArgWithLabel call");
      const label = expectIdentifier(args.at(1), "optionalArgWithLabel label");
      const result = getOptionalFormLabel(call, label.value);
      return result ? cloneExpr(result) : bool(false);
    },
    argsWithLabel: ({ args }) => {
      const call = expectForm(args.at(0), "argsWithLabel call");
      const label = expectIdentifier(args.at(1), "argsWithLabel label");
      const values = collectFormLabels(call, label.value);
      return new Form(values.map(cloneExpr));
    },
    identifier: ({ args }) => {
      const prefix = expectIdentifier(args.at(0), "identifier prefix");
      const identifier = new IdentifierAtom(
        `${prefix.value}$macro_id$${getSyntaxId()}`,
      );
      return identifier;
    },
    syntax_template: syntaxTemplateBuiltin,
    "`": syntaxTemplateBuiltin,
    if: ({ originalArgs, scope }) => {
      const allClauses = originalArgs.every(
        (arg) => isForm(arg) && arg.calls(":"),
      );
      if (allClauses) {
        for (const clause of originalArgs) {
          const conditionExpr = clause.at(1);
          const branchExpr = clause.at(2);
          if (!conditionExpr || !branchExpr) {
            throw new Error(`Invalid if expression`);
          }

          if (
            isIdentifierAtom(conditionExpr) &&
            conditionExpr.value === "else"
          ) {
            return evalMacroExpr(cloneExpr(branchExpr), scope);
          }

          const condResult = evalMacroExpr(
            handleOptionalConditionParenthesis(cloneExpr(conditionExpr)),
            scope,
          );

          if (getMacroTimeValue(condResult, scope)) {
            return evalMacroExpr(cloneExpr(branchExpr), scope);
          }
        }
        return new IdentifierAtom("nop");
      }

      const [condition, truthy, falsy] = originalArgs;
      if (!condition || !truthy) {
        throw new Error(`Invalid if expression`);
      }

      const condResult = evalMacroExpr(
        handleOptionalConditionParenthesis(cloneExpr(condition)),
        scope,
      );

      if (getMacroTimeValue(condResult, scope)) {
        return evalMacroExpr(cloneExpr(truthy), scope);
      }

      if (falsy) {
        return evalMacroExpr(cloneExpr(falsy), scope);
      }

      return new IdentifierAtom("nop");
    },
    slice: ({ args, originalArgs, scope }) => {
      const list = resolveForm(
        args.at(0),
        originalArgs.at(0),
        scope,
        "slice target",
      );
      const start = Number(getMacroTimeValue(args.at(1), scope));
      const endVal = args.at(2)
        ? Number(getMacroTimeValue(args.at(2), scope))
        : undefined;
      return new Form(list.toArray().slice(start, endVal).map(cloneExpr));
    },
    extract: ({ args, originalArgs, scope }) => {
      const list = resolveForm(
        args.at(0),
        originalArgs.at(0),
        scope,
        "extract target",
      );
      const index = Number(getMacroTimeValue(args.at(1), scope));
      return cloneExpr(list.at(index) ?? new IdentifierAtom("nop"));
    },
    get: ({ args, originalArgs, scope }) => {
      const list = resolveForm(
        args.at(0),
        originalArgs.at(0),
        scope,
        "get target",
      );
      const index = Number(getMacroTimeValue(args.at(1), scope));
      return cloneExpr(list.at(index) ?? new IdentifierAtom("nop"));
    },
    map: ({ args, scope }) => {
      const list = expectForm(args.at(0), "map target");
      const lambdaCandidate = args.at(1);
      const lambda = isMacroLambdaValue(lambdaCandidate)
        ? lambdaCandidate
        : evalMacroExpr(
            expectExpr(lambdaCandidate ?? new IdentifierAtom("nop")),
            scope,
          );
      if (!isMacroLambdaValue(lambda)) {
        throw new Error("map requires a macro lambda as the second argument");
      }
      const mapped = list
        .toArray()
        .map((value, index, array) =>
          callLambda(lambda, [
            cloneExpr(value),
            createInt(index),
            new Form(array.map(cloneExpr)),
          ]),
        )
        .map((res) => expectExpr(res));
      return new Form(mapped.map(cloneExpr));
    },
    reduce: ({ args, scope }) => {
      const list = expectForm(args.at(0), "reduce target");
      const start = cloneExpr(expectExpr(args.at(1)));
      const lambdaCandidate = args.at(2);
      const lambdaResult = isMacroLambdaValue(lambdaCandidate)
        ? lambdaCandidate
        : evalMacroExpr(
            expectExpr(lambdaCandidate ?? new IdentifierAtom("nop")),
            scope,
          );
      if (!isMacroLambdaValue(lambdaResult)) {
        throw new Error("reduce requires a macro lambda as the third argument");
      }

      let accumulator: MacroEvalResult = start;
      list.toArray().forEach((value, index, array) => {
        accumulator = callLambda(lambdaResult, [
          expectExpr(accumulator),
          cloneExpr(value),
          createInt(index),
          new Form(array.map(cloneExpr)),
        ]);
      });

      return accumulator;
    },
    push: ({ args }) => {
      const list = expectForm(args.at(0), "push target");
      const value = args.at(1);
      const rest = args.slice(2).map((arg) => expectExpr(arg));
      const elements = [
        ...list.toArray(),
        ...(value ? [expectExpr(value)] : []),
        ...rest,
      ];
      return new Form(elements.map(cloneExpr));
    },
    spread: ({ args }) => {
      const list = expectForm(args.at(0), "spread target");
      const value = expectForm(args.at(1), "spread source");
      return new Form([...list.toArray(), ...value.toArray()].map(cloneExpr));
    },
    concat: ({ args }) => {
      const first = expectExpr(args.at(0));
      const list = isForm(first)
        ? first
        : isIdentifierAtom(first)
          ? new Form([cloneExpr(first)])
          : expectForm(first, "concat target");
      const values = args.slice(1).flatMap((expr) => {
        const item = expectExpr(expr);
        return isForm(item) ? item.toArray() : [item];
      });
      return new Form([...list.toArray(), ...values].map(cloneExpr));
    },
    is_list: ({ args }) => bool(isForm(expectExpr(args.at(0)))),
    log: ({ args, scope }) => {
      const value = getMacroTimeValue(args.at(0), scope);
      console.error(JSON.stringify(value));
      return new Form(args.map((arg) => cloneExpr(expectExpr(arg))));
    },
    split: ({ args }) => {
      const target = expectIdentifier(args.at(0), "split target");
      const delimiter = expectIdentifier(args.at(1), "split delimiter");
      return new Form(
        target.value.split(delimiter.value).map((part) => {
          const atom = new IdentifierAtom(part);
          atom.setIsQuoted(true);
          return atom;
        }),
      );
    },
    char_to_code: ({ args }) => {
      const atom = expectExpr(args.at(0));
      if (!atom) throw new Error("char_to_code requires a value");
      if (isIdentifierAtom(atom)) {
        return createInt(atom.value.codePointAt(0) ?? 0);
      }
      if (isStringAtom(atom)) {
        return createInt(atom.value.codePointAt(0) ?? 0);
      }
      throw new Error("Unsupported value for char_to_code");
    },
  } satisfies Record<string, BuiltinFn | undefined>;
};
