import { createTailResumptionGuard } from "../runtime/resumptions.js";
import type { SemanticsPipelineResult } from "../context.js";
import type {
  ContinuationBackend,
  ContinuationBackendOptions,
  ContinuationMode,
  ContinuationResult,
  EffectContinuationRequest,
  EffectMir,
  EffectOperationInfo,
} from "./backend.js";
import { buildEffectMir } from "./effect-mir.js";
import type {
  HirCallExpr,
  HirEffectHandlerClause,
  HirExpression,
  HirFunction,
  HirLambdaExpr,
  HirPattern,
} from "../../semantics/hir/index.js";
import type {
  HirExprId,
  HirStmtId,
  SymbolId,
} from "../../semantics/ids.js";

const BRANCH_SKIPPED = Symbol("branch-skipped");

type Environment = {
  parent?: Environment;
  bindings: Map<SymbolId, unknown>;
};

type Callable =
  | { kind: "fn"; fn: HirFunction }
  | { kind: "lambda"; lambda: HirLambdaExpr; env: Environment }
  | { kind: "effect-op"; op: EffectOperationInfo }
  | { kind: "continuation"; resume: (value: unknown) => ContinuationResult }
  | {
      kind: "intrinsic";
      name: string;
      invoke: (args: readonly unknown[]) => unknown;
    };

const valueResult = (value: unknown): ContinuationResult => ({
  kind: "value",
  value,
});

const returnResult = (value: unknown): ContinuationResult => ({
  kind: "return",
  value,
});

const effectResult = (
  request: EffectContinuationRequest
): ContinuationResult => ({ kind: "effect", request });

const mapResult = (
  outcome: ContinuationResult,
  onValue: (value: unknown) => ContinuationResult
): ContinuationResult => {
  if (outcome.kind === "value") {
    return onValue(outcome.value);
  }
  if (outcome.kind === "return") {
    return outcome;
  }
  return effectResult({
    ...outcome.request,
    resume: (value) => mapResult(outcome.request.resume(value), onValue),
  });
};

const createEnv = (parent?: Environment): Environment => ({
  parent,
  bindings: new Map(),
});

const lookup = (env: Environment, symbol: SymbolId): unknown => {
  let cursor: Environment | undefined = env;
  while (cursor) {
    if (cursor.bindings.has(symbol)) {
      return cursor.bindings.get(symbol);
    }
    cursor = cursor.parent;
  }
  throw new Error(`missing binding for symbol ${symbol}`);
};

const bind = (env: Environment, symbol: SymbolId, value: unknown): void => {
  env.bindings.set(symbol, value);
};

const literalValue = (expr: HirExpression): unknown => {
  if (expr.exprKind !== "literal") {
    return undefined;
  }
  switch (expr.literalKind) {
    case "i32":
    case "i64":
      return Number.parseInt(expr.value, 10);
    case "f32":
    case "f64":
      return Number.parseFloat(expr.value);
    case "boolean":
      return expr.value === "true";
    case "string":
      return expr.value;
    case "void":
      return undefined;
    case "symbol":
      return expr.value;
    default:
      return expr.value;
  }
};

const matchOperation = (
  request: EffectContinuationRequest,
  clause: HirEffectHandlerClause
): boolean => request.opSymbol === clause.operation;

const opLabel = (op: EffectOperationInfo): string => op.name;

const handlerTail = (
  clause: HirEffectHandlerClause,
  mir: EffectMir
): HirEffectHandlerClause["tailResumption"] | undefined =>
  mir.handlerTails.get(clause.body);

const intrinsicAdd = (args: readonly unknown[]): unknown => {
  if (args.length === 0) return 0;
  return args.reduce(
    (acc, value) => (typeof acc === "number" && typeof value === "number" ? acc + value : acc),
    0
  );
};

const intrinsicEq = (args: readonly unknown[]): boolean => {
  if (args.length !== 2) return false;
  return args[0] === args[1];
};

const defaultIntrinsics = (): Map<string, Callable> =>
  new Map([
    [
      "+",
      {
        kind: "intrinsic",
        name: "+",
        invoke: intrinsicAdd,
      },
    ],
    [
      "==",
      {
        kind: "intrinsic",
        name: "==",
        invoke: intrinsicEq,
      },
    ],
  ]);

export class GcContinuationBackend implements ContinuationBackend {
  mode: ContinuationMode;
  #mir: EffectMir;
  #callables: Map<SymbolId, Callable>;
  #intrinsics: Map<string, Callable>;

  constructor({
    semantics,
    options,
  }: {
    semantics: SemanticsPipelineResult;
    options?: ContinuationBackendOptions;
  }) {
    this.#mir = buildEffectMir({ semantics, options });
    this.mode = this.#mir.stackSwitching ? "stack-switch" : "gc-trampoline";
    this.#callables = new Map();
    this.#intrinsics = defaultIntrinsics();

    semantics.hir.items.forEach((item) => {
      if (item.kind !== "function") {
        return;
      }
      if (!this.#mir.functions.has(item.symbol)) {
        return;
      }
      this.#callables.set(item.symbol, { kind: "fn", fn: item });
    });

    this.#mir.operations.forEach((op) => {
      this.#callables.set(op.symbol, { kind: "effect-op", op });
    });
  }

  run({ symbol, args = [] }: { symbol: SymbolId; args?: readonly unknown[] }): unknown {
    const callable = this.#callables.get(symbol);
    if (!callable || callable.kind !== "fn") {
      throw new Error(`unknown function symbol ${symbol}`);
    }
    const env = createEnv();
    callable.fn.parameters.forEach((param, index) => {
      bind(env, param.symbol, args[index]);
    });
    const outcome = this.#evalFunction(callable.fn, env);
    const resolved = this.#resolve(outcome);
    if (resolved.kind === "effect") {
      const op = this.#mir.operations.get(resolved.request.opSymbol);
      const name = op ? opLabel(op) : `op ${resolved.request.opSymbol}`;
      throw new Error(`unhandled effect ${name}`);
    }
    return resolved.value;
  }

  runByName({ name, args = [] }: { name: string; args?: readonly unknown[] }): unknown {
    const symbol = this.#resolveName(name);
    if (typeof symbol !== "number") {
      throw new Error(`unknown function ${name}`);
    }
    return this.run({ symbol, args });
  }

  #resolveName(name: string): SymbolId | undefined {
    for (const symbol of this.#callables.keys()) {
      const record = this.#mir.semantics.symbolTable.getSymbol(symbol);
      if (record.name === name) {
        return symbol;
      }
    }
    const root = this.#mir.semantics.symbolTable.rootScope;
    return this.#mir.semantics.symbolTable.resolve(name, root) as SymbolId | undefined;
  }

  #resolve(outcome: ContinuationResult): { kind: "value"; value: unknown } | { kind: "effect"; request: EffectContinuationRequest } {
    if (outcome.kind === "value") {
      return { kind: "value", value: outcome.value };
    }
    if (outcome.kind === "return") {
      return { kind: "value", value: outcome.value };
    }
    return { kind: "effect", request: outcome.request };
  }

  #evalFunction(fn: HirFunction, env: Environment): ContinuationResult {
    return this.#evalExpr(fn.body, env);
  }

  #evalExpr(exprId: HirExprId, env: Environment): ContinuationResult {
    const expr = this.#mir.semantics.hir.expressions.get(exprId);
    if (!expr) {
      throw new Error(`missing HirExpression ${exprId}`);
    }
    switch (expr.exprKind) {
      case "literal":
        return valueResult(literalValue(expr));
      case "identifier":
        return valueResult(this.#lookupIdentifier(expr.symbol, env));
      case "call":
        return this.#evalCall(expr, env);
      case "block":
        return this.#evalBlock(expr, env);
      case "effect-handler":
        return this.#evalEffectHandler(expr, env);
      case "lambda":
        return valueResult({ kind: "lambda", lambda: expr, env } satisfies Callable);
      case "tuple":
        return this.#evalTuple(expr, env);
      case "if":
        return this.#evalIf(expr, env);
      default:
        throw new Error(`unsupported expression kind ${expr.exprKind}`);
    }
  }

  #evalTuple(expr: Extract<HirExpression, { exprKind: "tuple" }>, env: Environment): ContinuationResult {
    let acc: ContinuationResult = valueResult([]);
    expr.elements.forEach((elementId, index) => {
      acc = mapResult(acc, (arr) =>
        mapResult(this.#evalExpr(elementId, env), (value) => {
          const next = Array.isArray(arr) ? [...arr] : [];
          next[index] = value;
          return valueResult(next);
        })
      );
    });
    return acc;
  }

  #evalIf(expr: Extract<HirExpression, { exprKind: "if" }>, env: Environment): ContinuationResult {
    for (const branch of expr.branches) {
      const outcome = mapResult(
        this.#evalExpr(branch.condition, env),
        (condition) =>
          condition
            ? this.#evalExpr(branch.value, env)
            : valueResult(BRANCH_SKIPPED)
      );
      const resolved = this.#resolve(outcome);
      if (resolved.kind === "effect") {
        return outcome;
      }
      if (resolved.value !== BRANCH_SKIPPED) {
        return outcome;
      }
    }

    if (typeof expr.defaultBranch === "number") {
      return this.#evalExpr(expr.defaultBranch, env);
    }
    return valueResult(undefined);
  }

  #evalCall(expr: HirCallExpr, env: Environment): ContinuationResult {
    const calleeResult = this.#evalExpr(expr.callee, env);
    return mapResult(calleeResult, (callee) =>
      this.#evalCallWithCallee({
        expr,
        env,
        callee,
      })
    );
  }

  #evalCallWithCallee({
    expr,
    env,
    callee,
  }: {
    expr: HirCallExpr;
    env: Environment;
    callee: unknown;
  }): ContinuationResult {
    const callable = callee as Callable;
    const argsResult = this.#evalArgs(expr.args, env);
    return mapResult(argsResult, (args) => {
      const resolvedArgs = Array.isArray(args) ? args : [];
      switch (callable?.kind) {
        case "fn":
          return this.#invokeFunction(callable.fn, resolvedArgs);
        case "lambda":
          return this.#invokeLambda(callable.lambda, callable.env, resolvedArgs);
        case "effect-op":
          return this.#performEffect(callable.op, resolvedArgs);
        case "continuation":
          return callable.resume(resolvedArgs[0]);
        case "intrinsic":
          return valueResult(callable.invoke(resolvedArgs));
        default:
          throw new Error("attempted to call a non-callable value");
      }
    });
  }

  #evalArgs(
    args: HirCallExpr["args"],
    env: Environment
  ): ContinuationResult {
    const values: unknown[] = [];
    let acc: ContinuationResult = valueResult(undefined);
    args.forEach((arg, index) => {
      acc = mapResult(acc, () =>
        mapResult(this.#evalExpr(arg.expr, env), (value) => {
          values[index] = value;
          return valueResult(undefined);
        })
      );
    });
    return mapResult(acc, () => valueResult(values));
  }

  #invokeFunction(fn: HirFunction, envArgs: readonly unknown[]): ContinuationResult {
    const env = createEnv();
    fn.parameters.forEach((param, index) => {
      bind(env, param.symbol, envArgs[index]);
    });
    return this.#evalFunction(fn, env);
  }

  #invokeLambda(
    lambda: HirLambdaExpr,
    captured: Environment,
    envArgs: readonly unknown[]
  ): ContinuationResult {
    const env = createEnv(captured);
    lambda.parameters.forEach((param, index) => {
      bind(env, param.symbol, envArgs[index]);
    });
    return this.#evalExpr(lambda.body, env);
  }

  #performEffect(
    op: EffectOperationInfo,
    args: readonly unknown[]
  ): ContinuationResult {
    const request: EffectContinuationRequest = {
      opSymbol: op.symbol,
      effectSymbol: op.effect,
      resumable: op.resumable,
      args,
      resume: (value) => valueResult(value),
    };
    return effectResult(request);
  }

  #evalBlock(
    expr: Extract<HirExpression, { exprKind: "block" }>,
    env: Environment
  ): ContinuationResult {
    let acc: ContinuationResult = valueResult(undefined);
    for (const stmtId of expr.statements) {
      const next = this.#evalStatement(stmtId, env);
      if (next.kind !== "value") {
        return next;
      }
      acc = next;
    }
    if (typeof expr.value === "number") {
      return this.#evalExpr(expr.value, env);
    }
    return acc;
  }

  #evalStatement(stmtId: HirStmtId, env: Environment): ContinuationResult {
    const stmt = this.#mir.semantics.hir.statements.get(stmtId);
    if (!stmt) {
      throw new Error(`missing HirStatement ${stmtId}`);
    }
    switch (stmt.kind) {
      case "let":
        return mapResult(this.#evalExpr(stmt.initializer, env), (value) => {
          this.#bindPattern(stmt.pattern, value, env);
          return valueResult(undefined);
        });
      case "expr-stmt":
        return this.#evalExpr(stmt.expr, env);
      case "return":
        if (typeof stmt.value === "number") {
          const value = this.#evalExpr(stmt.value, env);
          if (value.kind === "effect") {
            return effectResult({
              ...value.request,
              resume: (resumed) =>
                mapResult(value.request.resume(resumed), (val) =>
                  returnResult(val)
                ),
            });
          }
          if (value.kind === "return") {
            return value;
          }
          return returnResult(value.value);
        }
        return returnResult(undefined);
      default:
        throw new Error(`unsupported statement kind ${stmt.kind}`);
    }
  }

  #bindPattern(
    pattern: HirPattern,
    value: unknown,
    env: Environment
  ): void {
    if (!pattern) return;
    if (pattern.kind === "identifier") {
      bind(env, pattern.symbol, value);
      return;
    }
    if (pattern.kind === "wildcard") {
      return;
    }
    throw new Error(`unsupported pattern kind ${pattern.kind}`);
  }

  #evalEffectHandler(
    expr: Extract<HirExpression, { exprKind: "effect-handler" }>,
    env: Environment
  ): ContinuationResult {
    const bodyResult = this.#evalExpr(expr.body, env);
    const handled = this.#handleOutcome(bodyResult, expr, env);
    if (handled.kind === "effect") {
      return handled;
    }
    if (typeof expr.finallyBranch === "number") {
      const finalOutcome = this.#evalExpr(expr.finallyBranch, env);
      if (finalOutcome.kind === "effect") {
        return effectResult({
          ...finalOutcome.request,
          resume: (value) =>
            mapResult(finalOutcome.request.resume(value), () => handled),
        });
      }
    }
    return handled;
  }

  #handleOutcome(
    outcome: ContinuationResult,
    handlerExpr: Extract<HirExpression, { exprKind: "effect-handler" }>,
    env: Environment
  ): ContinuationResult {
    if (outcome.kind !== "effect") {
      return outcome;
    }
    const matchingClause = handlerExpr.handlers.find((clause) =>
      matchOperation(outcome.request, clause)
    );
    if (!matchingClause) {
      return effectResult({
        ...outcome.request,
        resume: (value) =>
          this.#handleOutcome(outcome.request.resume(value), handlerExpr, env),
      });
    }
    return this.#evaluateHandlerClause({
      clause: matchingClause,
      request: outcome.request,
      env,
    });
  }

  #evaluateHandlerClause({
    clause,
    request,
    env,
  }: {
    clause: HirEffectHandlerClause;
    request: EffectContinuationRequest;
    env: Environment;
  }): ContinuationResult {
    const clauseEnv = createEnv(env);
    const resumableGuard =
      request.resumable === "tail" ? handlerTail(clause, this.#mir) : undefined;
    const guard =
      resumableGuard?.enforcement === "runtime"
        ? createTailResumptionGuard({
            resume: request.resume,
            label: `tail resumption for ${opLabel(
              this.#mir.operations.get(request.opSymbol) ??
                ({
                  name: `op ${request.opSymbol}`,
                  symbol: request.opSymbol,
                  resumable: "tail",
                } as EffectOperationInfo)
            )}`,
          })
        : undefined;
    if (clause.parameters[0]) {
      const resumeCallable: Callable = {
        kind: "continuation",
        resume: guard ? guard.resume : request.resume,
      };
      bind(clauseEnv, clause.parameters[0]!.symbol, resumeCallable);
    }
    clause.parameters.slice(1).forEach((param, index) => {
      bind(clauseEnv, param.symbol, request.args[index]);
    });

    const clauseResult = this.#evalExpr(clause.body, clauseEnv);
    if (guard) {
      guard.finalize();
    }
    return clauseResult;
  }

  #lookupIdentifier(symbol: SymbolId, env: Environment): unknown {
    try {
      return lookup(env, symbol);
    } catch {
      const callable = this.#callables.get(symbol);
      if (callable) {
        return callable;
      }
      const record = this.#mir.semantics.symbolTable.getSymbol(symbol);
      const intrinsicName = (record.metadata as { intrinsicName?: string } | undefined)
        ?.intrinsicName;
      if (intrinsicName && this.#intrinsics.has(intrinsicName)) {
        return this.#intrinsics.get(intrinsicName);
      }
      throw new Error(`unbound identifier ${record.name ?? symbol}`);
    }
  }
}

export const createContinuationBackend = ({
  semantics,
  options,
}: {
  semantics: SemanticsPipelineResult;
  options?: ContinuationBackendOptions;
}): ContinuationBackend => new GcContinuationBackend({ semantics, options });
