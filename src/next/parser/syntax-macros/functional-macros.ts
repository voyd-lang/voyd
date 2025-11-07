import { Form } from "../ast/form.js";
import {
  Expr,
  IdentifierAtom,
  IntAtom,
  FloatAtom,
  BoolAtom,
  StringAtom,
  isForm,
  isIdentifierAtom,
  isIntAtom,
  isFloatAtom,
  isBoolAtom,
  isStringAtom,
} from "../ast/index.js";
import { getSyntaxId, Syntax } from "../ast/syntax.js";
import { SyntaxMacro } from "./types.js";

type MacroEvalResult = Expr | MacroLambdaValue;

type MacroLambdaValue = {
  kind: "macro-lambda";
  parameters: IdentifierAtom[];
  body: Expr[];
  scope: MacroScope;
  id: IdentifierAtom;
};

type MacroVariableBinding = {
  name: IdentifierAtom;
  value: MacroEvalResult;
  mutable: boolean;
};

type MacroDefinition = {
  name: IdentifierAtom;
  parameters: IdentifierAtom[];
  body: Expr[];
  scope: MacroScope;
  id: IdentifierAtom;
};

class MacroScope {
  #parent?: MacroScope;
  #macros = new Map<string, MacroDefinition>();
  #variables = new Map<string, MacroVariableBinding>();

  constructor(parent?: MacroScope) {
    this.#parent = parent;
  }

  child(): MacroScope {
    return new MacroScope(this);
  }

  defineMacro(definition: MacroDefinition) {
    this.#macros.set(definition.name.value, definition);
  }

  getMacro(name: string): MacroDefinition | undefined {
    return this.#macros.get(name) ?? this.#parent?.getMacro(name);
  }

  defineVariable(binding: MacroVariableBinding) {
    this.#variables.set(binding.name.value, binding);
  }

  getVariable(name: string): MacroVariableBinding | undefined {
    return this.#variables.get(name) ?? this.#parent?.getVariable(name);
  }

  assignVariable(name: string, value: MacroEvalResult): MacroVariableBinding {
    const binding = this.#variables.get(name);
    if (binding) {
      if (!binding.mutable) {
        throw new Error(`Variable ${name} is not mutable`);
      }
      binding.value = value;
      return binding;
    }

    const parent = this.#parent;
    if (parent) return parent.assignVariable(name, value);

    throw new Error(`Identifier ${name} is not defined`);
  }
}

let macroIdCounter = 0;

export const functionalMacros: SyntaxMacro = (form: Form): Form => {
  const scope = new MacroScope();
  return ensureForm(expandExpr(form, scope));
};

const expandExpr = (expr: Expr, scope: MacroScope): Expr => {
  if (!isForm(expr)) return expr;

  if (expr.calls("macro")) {
    return expandMacroDefinition(expr, scope);
  }

  if (expr.calls("macro_let")) {
    return expandMacroLet(expr, scope);
  }

  const head = expr.at(0);
  const macro = isIdentifierAtom(head) ? scope.getMacro(head.value) : undefined;
  if (macro) {
    const expanded = expandMacroCall(expr, macro, scope);
    return expandExpr(expanded, scope);
  }

  return expandForm(expr, scope);
};

const expandForm = (form: Form, scope: MacroScope): Form => {
  const head = form.at(0);
  const bodyScope = createsScopeFor(head) ? scope.child() : scope;
  const elements = form.toArray();
  const result: Expr[] = [];

  elements.forEach((child, index) => {
    if (isModuleName(head, index)) {
      result.push(child);
      return;
    }

    result.push(expandExpr(child, bodyScope));
  });

  return recreateForm(form, result);
};

const expandMacroDefinition = (form: Form, scope: MacroScope): Expr => {
  if (process.env.VITEST) {
    console.log(
      "expandMacroDefinition:",
      JSON.stringify(form.toJSON(), null, 2)
    );
  }
  const signature = expectForm(form.at(1), "macro signature");
  const name = expectIdentifier(signature.at(0), "macro name");
  const parameters = signature
    .toArray()
    .slice(1)
    .map((expr, index) =>
      expectIdentifier(
        expr,
        `macro parameter ${index + 1} for ${name.value ?? "anonymous macro"}`
      ).clone()
    );

  const bodyExpressions = form.toArray().slice(2).map(cloneExpr);

  const macro: MacroDefinition = {
    name: name.clone(),
    parameters,
    body: bodyExpressions,
    scope,
    id: new IdentifierAtom(`${name.value}#${macroIdCounter++}`),
  };

  scope.defineMacro(macro);
  return renderFunctionalMacro(macro);
};

const expandMacroLet = (form: Form, scope: MacroScope): Expr => {
  const assignment = expectForm(form.at(1), "macro let assignment");
  const operator = assignment.at(0);
  if (!isIdentifierAtom(operator) || operator.value !== "=") {
    throw new Error("macro_let expects an assignment expression");
  }
  const identifier = expectIdentifier(assignment.at(1), "macro let identifier");
  const initializer = assignment.at(2);
  if (!initializer) {
    throw new Error("macro_let requires an initializer");
  }

  const value = evalMacroExpr(cloneExpr(initializer), scope);
  const binding: MacroVariableBinding = {
    name: identifier.clone(),
    value: cloneMacroEvalResult(value),
    mutable: false,
  };
  scope.defineVariable(binding);

  return renderMacroVariable(binding);
};

const expandMacroCall = (
  call: Form,
  macro: MacroDefinition,
  scope: MacroScope
): Expr => {
  const invocationScope = new MacroScope(macro.scope);
  const args = call.toArray().slice(1).map(cloneExpr);
  const bodyArguments = new Form({
    location: call.location?.clone(),
    elements: args.map(cloneExpr),
  });

  invocationScope.defineVariable({
    name: new IdentifierAtom("body"),
    value: bodyArguments,
    mutable: false,
  });

  macro.parameters.forEach((param, index) => {
    const supplied = args.at(index);
    if (!supplied) {
      throw new Error(
        `Macro ${macro.name.value} expected ${macro.parameters.length} arguments, received ${index}`
      );
    }
    invocationScope.defineVariable({
      name: param.clone(),
      value: cloneExpr(supplied),
      mutable: false,
    });
  });

  let result: MacroEvalResult = new IdentifierAtom("nop");
  macro.body.forEach((expr) => {
    result = evalMacroExpr(cloneExpr(expr), invocationScope);
  });

  const normalized = expectExpr(result, "macro expansion result");
  if (call.location) normalized.setLocation(call.location.clone());
  return normalized;
};

type EvalOpts = {
  skipBuiltins?: Set<string>;
};

const evalMacroExpr = (
  expr: Expr,
  scope: MacroScope,
  opts: EvalOpts = {}
): MacroEvalResult => {
  if (isIdentifierAtom(expr)) {
    const value = scope.getVariable(expr.value)?.value;
    return value ? cloneMacroEvalResult(value) : expr;
  }

  if (!isForm(expr)) return expr;

  if (expr.calls("block")) {
    return evalBlock(expr, scope);
  }

  return evalCall(expr, scope, opts);
};

const evalBlock = (block: Form, scope: MacroScope): MacroEvalResult => {
  const childScope = scope.child();
  let result: MacroEvalResult = new IdentifierAtom("nop");

  block
    .toArray()
    .slice(1)
    .forEach((expr) => {
      result = evalMacroExpr(expr, childScope);
    });

  return result;
};

const fnsToSkipArgEval = new Set([
  "if",
  "syntax_template",
  "=>",
  "define",
  "=",
]);

type BuiltinContext = {
  call: Form;
  args: MacroEvalResult[];
  originalArgs: Expr[];
  scope: MacroScope;
};

type BuiltinFn = (ctx: BuiltinContext) => MacroEvalResult;

const builtins: Record<string, BuiltinFn | undefined> = {
  block: ({ args }) => {
    const value = args.at(-1);
    return value
      ? expectExpr(value, "block result")
      : new IdentifierAtom("nop");
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
  "=": ({ originalArgs, scope }) => {
    const identifier = expectIdentifier(
      originalArgs.at(0),
      "assignment target"
    );
    const value = evalMacroExpr(cloneExpr(originalArgs.at(1)!), scope);
    scope.assignVariable(identifier.value, cloneMacroEvalResult(value));
    return new IdentifierAtom("nop");
  },
  ":": ({ args }) => {
    const value = args.at(1);
    return value ? expectExpr(value, "label value") : new IdentifierAtom("nop");
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
      id: new IdentifierAtom(`lambda#${macroIdCounter++}`),
    };
  },
  calls: ({ args }) => {
    const call = expectForm(args.at(0), "calls target");
    const label = expectIdentifier(args.at(1), "calls identifier");
    const target = call.at(0);
    if (!isIdentifierAtom(target)) return bool(false);
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
      `${prefix.value}$macro_id$${getSyntaxId()}`
    );
    return identifier;
  },
  mark_moved: ({ args }) => {
    const variable = expectIdentifier(args.at(0), "mark_moved target").clone();
    return variable;
  },
  syntax_template: ({ originalArgs, scope }) => {
    const expanded = expandSyntaxTemplate(originalArgs, scope);
    if (expanded.length === 1) return cloneExpr(expanded[0]!);
    return new Form(expanded.map(cloneExpr));
  },
  if: ({ originalArgs, scope }) => {
    const [condition, truthy, falsy] = originalArgs;
    if (!condition || !truthy) {
      throw new Error(`Invalid if expression`);
    }

    const condResult = evalMacroExpr(
      handleOptionalConditionParenthesis(cloneExpr(condition)),
      scope
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
      "slice target"
    );
    const start = Number(getMacroTimeValue(args.at(1), scope));
    const endVal = args.at(2)
      ? Number(getMacroTimeValue(args.at(2), scope))
      : undefined;
    return new Form(list.toArray().slice(start, endVal).map(cloneExpr));
  },
  extract: ({ args, originalArgs, scope }) => {
    if (process.env.DEBUG_EXTRACT) {
      console.error(
        "extract args",
        JSON.stringify(
          {
            evaluated: args.map((arg) => {
              if (isForm(arg)) return arg.toJSON();
              if (isMacroLambdaValue(arg)) return { lambda: true };
              const expr = expectExpr(arg, "extract debug value");
              return expr.toJSON?.() ?? expr;
            }),
            original: originalArgs.map((arg) =>
              isForm(arg) ? arg.toJSON() : arg?.toJSON?.() ?? arg
            ),
          },
          null,
          2
        )
      );
    }
    const list = resolveForm(
      args.at(0),
      originalArgs.at(0),
      scope,
      "extract target"
    );
    const index = Number(getMacroTimeValue(args.at(1), scope));
    return cloneExpr(list.at(index) ?? new IdentifierAtom("nop"));
  },
  get: ({ args, originalArgs, scope }) => {
    const list = resolveForm(
      args.at(0),
      originalArgs.at(0),
      scope,
      "get target"
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
          scope
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
        ])
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
          scope
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
      })
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
};

const evalCall = (
  form: Form,
  scope: MacroScope,
  opts: EvalOpts
): MacroEvalResult => {
  const head = form.at(0);
  if (!isIdentifierAtom(head)) {
    const evaluated = form
      .toArray()
      .map((expr) => expectExpr(evalMacroExpr(expr, scope, opts)));
    return recreateForm(form, evaluated);
  }

  const id = head.value;
  const macro = scope.getMacro(id);
  if (macro) {
    const expanded = expandMacroCall(form, macro, scope);
    return evalMacroExpr(expanded, scope, opts);
  }

  const argExprs = form.toArray().slice(1);
  const args: MacroEvalResult[] = fnsToSkipArgEval.has(id)
    ? argExprs
    : argExprs.map((expr) => evalMacroExpr(expr, scope, opts));

  const builtin = builtins[id];
  if (builtin && !opts.skipBuiltins?.has(id)) {
    return builtin({
      call: form,
      args,
      originalArgs: argExprs,
      scope,
    });
  }

  const evaluatedHead = evalMacroExpr(head, scope, opts);
  if (isMacroLambdaValue(evaluatedHead)) {
    return callLambda(
      evaluatedHead,
      args.filter((e) => e instanceof Syntax)
    );
  }

  const normalizedArgs = args.map((arg) => expectExpr(arg));
  return recreateForm(form, [expectExpr(evaluatedHead), ...normalizedArgs]);
};

const callLambda = (
  lambda: MacroLambdaValue,
  args: Expr[]
): MacroEvalResult => {
  const lambdaScope = new MacroScope(lambda.scope);
  lambdaScope.defineVariable({
    name: new IdentifierAtom("&lambda"),
    value: cloneMacroEvalResult(lambda),
    mutable: false,
  });

  lambda.parameters.forEach((param, index) => {
    const arg = args.at(index);
    if (!arg) {
      throw new Error(
        `Lambda expected ${lambda.parameters.length} arguments, received ${index}`
      );
    }
    lambdaScope.defineVariable({
      name: param.clone(),
      value: cloneExpr(arg),
      mutable: false,
    });
  });

  let result: MacroEvalResult = new IdentifierAtom("nop");
  lambda.body.forEach((expr) => {
    result = evalMacroExpr(cloneExpr(expr), lambdaScope);
  });

  return result;
};

const isMacroLambdaValue = (value: unknown): value is MacroLambdaValue =>
  typeof value === "object" &&
  (value as MacroLambdaValue)?.kind === "macro-lambda";

const renderFunctionalMacro = (macro: MacroDefinition): Form =>
  new Form([
    new IdentifierAtom("functional-macro"),
    macro.id.clone(),
    new Form([
      new IdentifierAtom("parameters"),
      ...macro.parameters.map((param) => param.clone()),
    ]),
    new Form([new IdentifierAtom("block"), ...macro.body.map(cloneExpr)]),
  ]);

const renderMacroVariable = (binding: MacroVariableBinding): Form =>
  new Form([
    new IdentifierAtom("define-macro-variable"),
    binding.name.clone(),
    new Form([new IdentifierAtom("reserved-for-type")]),
    new Form([
      new IdentifierAtom("is-mutable"),
      binding.mutable
        ? new IdentifierAtom("true")
        : new IdentifierAtom("false"),
    ]),
  ]);

const createsScopeFor = (expr: Expr | undefined): boolean =>
  isIdentifierAtom(expr) &&
  (expr.value === "block" ||
    expr.value === "module" ||
    expr.value === "fn" ||
    expr.value === "ast");

const isModuleName = (head: Expr | undefined, index: number): boolean =>
  isIdentifierAtom(head) && head.value === "module" && index === 1;

const recreateForm = (form: Form, elements: Expr[]): Form =>
  new Form({
    location: form.location?.clone(),
    elements,
  });

const ensureForm = (expr: Expr): Form =>
  isForm(expr) ? expr : new Form([expr]);

const cloneExpr = (expr: Expr): Expr => expr.clone();

const cloneMacroEvalResult = (value: MacroEvalResult): MacroEvalResult => {
  if (isMacroLambdaValue(value)) {
    return {
      kind: "macro-lambda",
      parameters: value.parameters.map((param) => param.clone()),
      body: value.body.map(cloneExpr),
      scope: value.scope,
      id: value.id.clone(),
    };
  }

  return cloneExpr(value);
};

const expectExpr = (
  value: MacroEvalResult | undefined,
  context = "macro evaluation"
): Expr => {
  if (!value) {
    throw new Error(`Expected expression for ${context}`);
  }

  if (isMacroLambdaValue(value)) {
    throw new Error(
      `Expected expression for ${context}, received macro lambda`
    );
  }

  return value;
};

const expectForm = (
  expr: MacroEvalResult | undefined,
  context: string
): Form => {
  if (!isForm(expr)) {
    throw new Error(`Expected form for ${context}`);
  }
  return expr;
};

const expectIdentifier = (
  expr: MacroEvalResult | undefined,
  context: string
): IdentifierAtom => {
  if (!isIdentifierAtom(expr)) {
    throw new Error(`Expected identifier for ${context}`);
  }
  return expr;
};

const createInt = (value: number): IntAtom =>
  new IntAtom({ value: `${Math.trunc(value)}` });

const createFloat = (value: number): FloatAtom =>
  new FloatAtom({ value: `${value}` });

const createBool = (value: boolean): BoolAtom =>
  new BoolAtom({ value: value ? "true" : "false" });

const bool = (value: unknown): BoolAtom => createBool(Boolean(value));

const evaluateMacroValue = (
  expr: Expr | undefined,
  scope: MacroScope
): unknown => {
  if (!expr) return undefined;
  const evaluated = evalMacroExpr(cloneExpr(expr), scope);
  return getMacroTimeValue(evaluated, scope);
};

const binaryLogic = (
  { originalArgs, scope }: BuiltinContext,
  fn: (l: any, r: any) => boolean
): boolean => {
  const left = evaluateMacroValue(originalArgs.at(0), scope);
  const right = evaluateMacroValue(originalArgs.at(1), scope);
  return fn(left, right);
};

const arithmetic = (
  { originalArgs, scope }: BuiltinContext,
  fn: (l: number, r: number) => number | string
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
          expectIdentifier(item, `lambda parameter ${index + 1}`)
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
        expectIdentifier(item, `lambda tuple parameter ${index + 1}`)
      )
      .map((identifier) => identifier.clone());
  }

  return elements.map((item, index) =>
    expectIdentifier(item, `lambda parameter ${index + 1}`)
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
        if (expr.calls("~~")) {
          const value = expr.at(1) ?? new IdentifierAtom("nop");
          const evaluated = evalMacroExpr(value, scope, {
            skipBuiltins: new Set([":"]),
          });
          const normalized = expectExpr(evaluated);
          return isForm(normalized)
            ? normalized.toArray().map(cloneExpr)
            : [cloneExpr(normalized)];
        }

        if (expr.calls("~")) {
          const value = expr.at(1) ?? new IdentifierAtom("nop");
          return [expectExpr(evalMacroExpr(value, scope))];
        }
      }

      if (isIdentifierAtom(expr)) {
        if (expr.value.startsWith("~~")) {
          const identifier = new IdentifierAtom(expr.value.slice(2));
          const evaluated = evalMacroExpr(identifier, scope);
          const normalized = expectExpr(evaluated);
          return isForm(normalized)
            ? normalized.toArray().map(cloneExpr)
            : [cloneExpr(normalized)];
        }

        if (expr.value.startsWith("~")) {
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

const getMacroTimeValue = (
  expr: Expr | MacroEvalResult | undefined,
  scope: MacroScope
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

const collectFormLabels = (form: Form, label: string): Expr[] => {
  const args = form.toArray().slice(1);
  const result: Expr[] = [];
  args.forEach((expr) => {
    if (!isForm(expr)) return;
    if (!expr.calls(":")) return;
    const labelExpr = expr.at(1);
    if (!isIdentifierAtom(labelExpr)) return;
    if (labelExpr.value === label) {
      const value = expr.at(2);
      if (value) result.push(value);
    }
  });
  return result;
};

const getOptionalFormLabel = (form: Form, label: string): Expr | undefined => {
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
  context: string
): Form => {
  if (evaluated) {
    const expr = evaluated instanceof Form ? evaluated : expectExpr(evaluated);
    if (isForm(expr)) return expr;
  }

  if (original) {
    const result = evalMacroExpr(cloneExpr(original), scope);
    const expr = expectExpr(result);
    if (isForm(expr)) return expr;
  }

  throw new Error(`Expected form for ${context}`);
};
