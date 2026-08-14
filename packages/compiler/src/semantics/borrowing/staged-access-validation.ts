import { diagnosticFromCode } from "../../diagnostics/index.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import type { StagedAccess } from "../../staged-access.js";
import type { SymbolTable } from "../binder/index.js";
import {
  walkExpression,
  type HirFunction,
  type HirGraph,
  type HirPattern,
} from "../hir/index.js";
import type { Diagnostic, HirExprId, SymbolId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import {
  indexCallArgumentFor,
  type CallableBorrowIndex,
  type CallableBorrowIndexCall,
} from "./callable-borrow-index.js";
import type { BorrowingDependency } from "./dependency.js";
import { buildCallableCfg } from "./ordinary-mutation-liveness.js";
import {
  OrdinaryParameterAccess,
  type OrdinaryMutationSummary,
} from "./ordinary-mutation-summary.js";
import {
  typeCanCarryReference,
} from "./reference-bearing.js";

type StagedEvent = {
  readsSource: boolean;
  writesDestination: boolean;
  compatibleForwarding: boolean;
};

type ValidationStats = {
  declarations: number;
  cfgBlocks: number;
  cfgEdges: number;
  facts: number;
  workItems: number;
  forwarding: number;
  traitChecks: number;
  violations: number;
};

/**
 * Check the local ordering promise behind `@staged`.
 *
 * The dataflow state is one monotone bit: whether the destination may already
 * have been written on a path. Each CFG block is therefore processed at most
 * twice, independent of projection depth or call-graph depth.
 */
export const validateStagedAccessContracts = ({
  functions,
  indexes,
  hir,
  typing,
  symbolTable,
  moduleId,
  dependencies,
  localSummaries,
}: {
  functions: readonly HirFunction[];
  indexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  localSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
}): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const stats: ValidationStats = {
    declarations: 0,
    cfgBlocks: 0,
    cfgEdges: 0,
    facts: 0,
    workItems: 0,
    forwarding: 0,
    traitChecks: 0,
    violations: 0,
  };
  const importedSummaries = new Map<string, OrdinaryMutationSummary>();
  dependencies.forEach((dependency, dependencyModuleId) =>
    dependency.ordinaryMutationSummaries.forEach((summary, symbol) =>
      importedSummaries.set(`${dependencyModuleId}::${symbol}`, summary),
    ),
  );

  const inheritedContracts = new Map<SymbolId, StagedAccess>();
  typing.traitMethodImpls.forEach((mapping, implementation) => {
    const declaration = typing.traits
      .getDecl(mapping.traitSymbol)
      ?.methods.find((method) => method.symbol === mapping.traitMethodSymbol);
    const expected = declaration?.stagedAccess;
    if (!expected) return;
    stats.traitChecks += 1;
    const signature = typing.functions.getSignature(implementation);
    const explicit = signature?.stagedAccess;
    if (explicit && !sameStagedAccess(expected, explicit)) {
      const fn = functions.find(
        (candidate) => candidate.symbol === implementation,
      );
      diagnostics.push(
        stagedDiagnostic({
          callable: symbolName(implementation, symbolTable),
          reason: `trait implementation declares a different @staged destination than parameter ${expected.destinationParameterIndex + 1}`,
          span: fn?.span ?? declaration.span,
        }),
      );
      stats.violations += 1;
      return;
    }
    inheritedContracts.set(implementation, expected);
    if (signature && !signature.stagedAccess) signature.stagedAccess = expected;
    const index = indexes.get(implementation);
    if (index?.signature && !index.signature.stagedAccess) {
      index.signature.stagedAccess = expected;
    }
  });

  functions.forEach((fn) => {
    const contract = fn.stagedAccess ?? inheritedContracts.get(fn.symbol);
    const index = indexes.get(fn.symbol);
    if (!contract || !index) return;
    stats.declarations += 1;
    const signature = typing.functions.getSignature(fn.symbol);
    const destination = index.parameters[contract.destinationParameterIndex];
    const summary = localSummaries.get(fn.symbol);
    const invalidReason =
      destination?.bindingKind !== "mutable-ref"
        ? "the destination must be a mutable-reference parameter"
        : !signature || !typing.effects.isEmpty(signature.effectRow)
          ? "the declaration must have an empty effect row"
          : !summary
            ? "the callable body could not be summarized"
            : summary.ambientAccess !== OrdinaryParameterAccess.Unused
              ? "the body may access ambient mutable state"
              : summary.reentrant
                ? "the body may invoke an unknown or reentrant callback"
                : summary.maySuspend
                  ? "the body may suspend"
                  : undefined;
    if (invalidReason) {
      diagnostics.push(
        stagedDiagnostic({
          callable: symbolName(fn.symbol, symbolTable),
          reason: invalidReason,
          span: fn.span,
        }),
      );
      stats.violations += 1;
      return;
    }

    const events = collectStagedEvents({
      body: fn.body,
      contract,
      index,
      hir,
      moduleId,
      localSummaries,
      importedSummaries,
      typing,
    });
    stats.facts += events.size;
    stats.forwarding += Array.from(events.values()).filter(
      (event) => event.compatibleForwarding,
    ).length;
    const cfg = buildCallableCfg({ body: fn.body, hir });
    stats.cfgBlocks += cfg.blocks.length;
    stats.cfgEdges += cfg.edgeCount;
    const failure = stagedOrderFailure({ cfg, events });
    stats.workItems += failure.workItems;
    if (failure.expression === undefined) return;
    diagnostics.push(
      stagedDiagnostic({
        callable: symbolName(fn.symbol, symbolTable),
        reason: failure.reason,
        span: hir.expressions.get(failure.expression)?.span ?? fn.span,
      }),
    );
    stats.violations += 1;
  });

  recordStats(stats);
  return diagnostics;
};

const collectStagedEvents = ({
  body,
  contract,
  index,
  hir,
  moduleId,
  localSummaries,
  importedSummaries,
  typing,
}: {
  body: HirExprId;
  contract: StagedAccess;
  index: CallableBorrowIndex;
  hir: HirGraph;
  moduleId: string;
  localSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  importedSummaries: ReadonlyMap<string, OrdinaryMutationSummary>;
  typing: TypingResult;
}): ReadonlyMap<HirExprId, StagedEvent> => {
  const result = new Map<HirExprId, StagedEvent>();
  const sourceParameters = new Set(
    index.parameters.flatMap((parameter) =>
      parameter.parameter !== contract.destinationParameterIndex &&
      parameter.referenceCapable === true
        ? [parameter.parameter]
        : [],
    ),
  );
  const localOrigins = collectParameterOriginsBySymbol({
    body,
    index,
    hir,
    typing,
  });
  const callsByExpression = new Map(
    index.calls.map((call) => [call.exprId, call]),
  );
  const add = (expression: HirExprId, event: Partial<StagedEvent>): void => {
    const current = result.get(expression) ?? {
      readsSource: false,
      writesDestination: false,
      compatibleForwarding: false,
    };
    result.set(expression, {
      readsSource: current.readsSource || event.readsSource === true,
      writesDestination:
        current.writesDestination || event.writesDestination === true,
      compatibleForwarding:
        current.compatibleForwarding || event.compatibleForwarding === true,
    });
  };

  const callExpressions = new Set(index.calls.map((call) => call.exprId));
  index.accesses.forEach((access) => {
    if (
      !access.place ||
      callExpressions.has(access.exprId) ||
      access.role === "call-argument" ||
      access.role === "call-operand"
    ) {
      return;
    }
    const origins = localOrigins.origins.get(access.place.root);
    if (
      localOrigins.independentOuterSymbols.has(access.place.root) &&
      !access.place.projections.some(
        (projection) => projection.kind === "dereference",
      )
    ) {
      return;
    }
    if (!origins || origins.size === 0) return;
    const expression = access.exprId;
    if (origins.has(contract.destinationParameterIndex)) {
      if (access.kind === "write") add(expression, { writesDestination: true });
    }
    if (Array.from(origins).some((origin) => sourceParameters.has(origin))) {
      add(expression, { readsSource: true });
    }
  });

  index.calls.forEach((call) => {
    if (call.intrinsicName === "~") return;
    const summary = validationSummaryForCall({
      call,
      moduleId,
      localSummaries,
      importedSummaries,
    });
    let readsSource = false;
    let writesDestination = false;
    call.arguments.forEach((argument) => {
      const accesses = callParameterAccesses(
        call,
        summary,
        argument.parameter,
      );
      if (
        accesses.direct === OrdinaryParameterAccess.Unused &&
        accesses.reachable === OrdinaryParameterAccess.Unused
      ) {
        return;
      }
      const originsFor = (ignoreIndependentOuter: boolean) =>
        typeof argument.expression === "number"
          ? expressionParameterOrigins({
              expressionId: argument.expression,
              origins: localOrigins.origins,
              independentOuterSymbols: localOrigins.independentOuterSymbols,
              ignoreIndependentOuter,
              calls: callsByExpression,
              hir,
              typing,
              memo: new Map(),
              active: new Set(),
            })
          : callerParametersForArgument(argument, index);
      const directOrigins =
        accesses.direct === OrdinaryParameterAccess.Unused
          ? new Set<number>()
          : originsFor(true);
      const reachableOrigins =
        accesses.reachable === OrdinaryParameterAccess.Unused
          ? new Set<number>()
          : originsFor(false);
      const allOrigins = new Set([...directOrigins, ...reachableOrigins]);
      if (
        Array.from(allOrigins).some((origin) => sourceParameters.has(origin))
      ) {
        readsSource = true;
      }
      if (
        (accesses.direct === OrdinaryParameterAccess.Write &&
          directOrigins.has(contract.destinationParameterIndex)) ||
        (accesses.reachable === OrdinaryParameterAccess.Write &&
          reachableOrigins.has(contract.destinationParameterIndex))
      ) {
        writesDestination = true;
      }
    });
    if (!readsSource && !writesDestination) return;
    const compatibleForwarding =
      readsSource &&
      writesDestination &&
      callPreservesStagedOrder({ call, contract, index });
    add(call.exprId, {
      readsSource,
      writesDestination,
      compatibleForwarding,
    });
  });
  return result;
};

const callerParametersForArgument = (
  argument: CallableBorrowIndexCall["arguments"][number],
  index: CallableBorrowIndex,
): ReadonlySet<number> => {
  const result = new Set(argument.callerParameterOrigins ?? []);
  if (argument.place) {
    const direct = index.parameterPlaces.get(argument.place.root)?.parameter;
    if (direct !== undefined) result.add(direct);
  }
  return result;
};

const collectParameterOriginsBySymbol = ({
  body,
  index,
  hir,
  typing,
}: {
  body: HirExprId;
  index: CallableBorrowIndex;
  hir: HirGraph;
  typing: TypingResult;
}): {
  origins: ReadonlyMap<SymbolId, ReadonlySet<number>>;
  independentOuterSymbols: ReadonlySet<SymbolId>;
} => {
  const origins = new Map<SymbolId, Set<number>>();
  index.parameterPlaces.forEach(({ parameter }, symbol) =>
    origins.set(symbol, new Set([parameter])),
  );
  const bindings: { symbols: readonly SymbolId[]; value: HirExprId }[] = [];
  walkExpression({
    exprId: body,
    hir,
    options: { skipLambdas: true },
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind !== "let") return;
      bindings.push({
        symbols: patternSymbols(statement.pattern),
        value: statement.initializer,
      });
    },
    onEnterExpression: (_expressionId, expression) => {
      if (expression.exprKind !== "assign") return;
      if (expression.pattern) {
        bindings.push({
          symbols: patternSymbols(expression.pattern),
          value: expression.value,
        });
        return;
      }
      if (typeof expression.target !== "number") return;
      const target = hir.expressions.get(expression.target);
      if (target?.exprKind === "identifier") {
        bindings.push({ symbols: [target.symbol], value: expression.value });
      }
    },
  });
  const calls = new Map(index.calls.map((call) => [call.exprId, call]));
  const assignmentsBySymbol = new Map<SymbolId, HirExprId[]>();
  bindings.forEach((binding) =>
    binding.symbols.forEach((symbol) => {
      const values = assignmentsBySymbol.get(symbol) ?? [];
      values.push(binding.value);
      assignmentsBySymbol.set(symbol, values);
    }),
  );
  const independentOuterSymbols = new Set(
    Array.from(assignmentsBySymbol).flatMap(([symbol, values]) =>
      values.length > 0 &&
      values.every((value) =>
        expressionHasFreshOuterIdentity(value, calls),
      )
        ? [symbol]
        : [],
    ),
  );
  const boundSymbols = new Set(bindings.flatMap((binding) => binding.symbols));
  const maxInsertions = Math.max(
    1,
    boundSymbols.size * index.parameters.length,
  );
  let insertions = 0;
  let changed = true;
  while (changed && insertions <= maxInsertions) {
    changed = false;
    const memo = new Map<HirExprId, ReadonlySet<number>>();
    bindings.forEach((binding) => {
      const values = expressionParameterOrigins({
        expressionId: binding.value,
        origins,
        independentOuterSymbols,
        ignoreIndependentOuter: false,
        calls,
        hir,
        typing,
        memo,
        active: new Set(),
      });
      binding.symbols.forEach((symbol) => {
        const current = origins.get(symbol) ?? new Set<number>();
        values.forEach((value) => {
          if (current.has(value)) return;
          current.add(value);
          insertions += 1;
          changed = true;
        });
        if (current.size > 0) origins.set(symbol, current);
      });
    });
  }
  if (insertions > maxInsertions) {
    throw new Error("staged access origin analysis exceeded its finite bound");
  }
  return { origins, independentOuterSymbols };
};

const expressionParameterOrigins = ({
  expressionId,
  origins,
  independentOuterSymbols,
  ignoreIndependentOuter,
  calls,
  hir,
  typing,
  memo,
  active,
}: {
  expressionId: HirExprId;
  origins: ReadonlyMap<SymbolId, ReadonlySet<number>>;
  independentOuterSymbols: ReadonlySet<SymbolId>;
  ignoreIndependentOuter: boolean;
  calls: ReadonlyMap<HirExprId, CallableBorrowIndexCall>;
  hir: HirGraph;
  typing: TypingResult;
  memo: Map<HirExprId, ReadonlySet<number>>;
  active: Set<HirExprId>;
}): ReadonlySet<number> => {
  const cached = memo.get(expressionId);
  if (cached) return cached;
  if (active.has(expressionId)) return new Set();
  const type =
    typing.resolvedExprTypes.get(expressionId) ??
    typing.borrowResolvedExprTypes.get(expressionId);
  if (typeof type === "number" && !typeCanCarryReference(type, typing)) {
    return new Set();
  }
  const expression = hir.expressions.get(expressionId);
  if (!expression) return new Set();
  const nextActive = new Set(active).add(expressionId);
  const merge = (children: readonly HirExprId[]): ReadonlySet<number> =>
    new Set(
      children.flatMap((child) =>
        Array.from(
          expressionParameterOrigins({
            expressionId: child,
            origins,
            independentOuterSymbols,
            ignoreIndependentOuter,
            calls,
            hir,
            typing,
            memo,
            active: nextActive,
          }),
        ),
      ),
    );
  let result: ReadonlySet<number>;
  switch (expression.exprKind) {
    case "literal":
    case "overload-set":
    case "continue":
      result = new Set();
      break;
    case "identifier":
      result =
        ignoreIndependentOuter && independentOuterSymbols.has(expression.symbol)
          ? new Set()
          : (origins.get(expression.symbol) ?? new Set());
      break;
    case "field-access": {
      result = expressionParameterOrigins({
        expressionId: expression.target,
        origins,
        independentOuterSymbols,
        ignoreIndependentOuter: false,
        calls,
        hir,
        typing,
        memo,
        active: nextActive,
      });
      break;
    }
    case "tuple":
      result = merge(expression.elements);
      break;
    case "object-literal":
      result = merge(expression.entries.map((entry) => entry.value));
      break;
    case "call": {
      const identity = calls.get(expressionId)?.signature?.resultIdentity;
      result =
        identity?.kind === "detached"
          ? new Set()
          : merge(expression.args.map((argument) => argument.expr));
      break;
    }
    case "method-call": {
      const identity = calls.get(expressionId)?.signature?.resultIdentity;
      result =
        identity?.kind === "detached"
          ? new Set()
          : merge([
              expression.target,
              ...expression.args.map((argument) => argument.expr),
            ]);
      break;
    }
    case "assign":
      result = merge([expression.value]);
      break;
    case "block":
      result =
        typeof expression.value === "number"
          ? merge([expression.value])
          : new Set();
      break;
    case "if":
    case "cond":
      result = merge([
        ...expression.branches.map((branch) => branch.value),
        ...(typeof expression.defaultBranch === "number"
          ? [expression.defaultBranch]
          : []),
      ]);
      break;
    case "match":
      result = merge(expression.arms.map((arm) => arm.value));
      break;
    case "break":
      result =
        typeof expression.value === "number"
          ? merge([expression.value])
          : new Set();
      break;
    case "effect-handler":
      result = merge([
        expression.body,
        ...expression.handlers.map((handler) => handler.body),
        ...(typeof expression.finallyBranch === "number"
          ? [expression.finallyBranch]
          : []),
      ]);
      break;
    case "lambda":
      result = new Set(
        expression.captures.flatMap((capture) =>
          Array.from(origins.get(capture.symbol) ?? []),
        ),
      );
      break;
    case "loop":
      result = merge([expression.body]);
      break;
    case "while":
      result = merge([expression.body]);
      break;
  }
  memo.set(expressionId, result);
  return result;
};

const expressionHasFreshOuterIdentity = (
  expression: HirExprId,
  calls: ReadonlyMap<HirExprId, CallableBorrowIndexCall>,
): boolean => calls.get(expression)?.signature?.resultIdentity?.kind === "fresh";

const patternSymbols = (pattern: HirPattern): readonly SymbolId[] => {
  switch (pattern.kind) {
    case "identifier":
      return [pattern.symbol];
    case "tuple":
      return pattern.elements.flatMap(patternSymbols);
    case "destructure":
      return [
        ...pattern.fields.flatMap((field) => patternSymbols(field.pattern)),
        ...(pattern.spread ? patternSymbols(pattern.spread) : []),
      ];
    case "type":
      return pattern.binding ? patternSymbols(pattern.binding) : [];
    case "wildcard":
      return [];
  }
};

const validationSummaryForCall = ({
  call,
  moduleId,
  localSummaries,
  importedSummaries,
}: {
  call: CallableBorrowIndexCall;
  moduleId: string;
  localSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  importedSummaries: ReadonlyMap<string, OrdinaryMutationSummary>;
}): OrdinaryMutationSummary | undefined => {
  if (
    call.intrinsic ||
    call.openTraitDispatch ||
    call.argumentPlanAmbiguous ||
    call.targets.length !== 1
  ) {
    return undefined;
  }
  const target = call.targets[0]!;
  return target.moduleId === moduleId
    ? localSummaries.get(target.symbol)
    : importedSummaries.get(`${target.moduleId}::${target.symbol}`);
};

const callParameterAccesses = (
  call: CallableBorrowIndexCall,
  summary: OrdinaryMutationSummary | undefined,
  parameter: number,
): {
  direct: OrdinaryParameterAccess;
  reachable: OrdinaryParameterAccess;
} => {
  if (call.intrinsicName === "__array_set") {
    return {
      direct:
        parameter === 0
          ? OrdinaryParameterAccess.Write
          : OrdinaryParameterAccess.Read,
      reachable: OrdinaryParameterAccess.Unused,
    };
  }
  if (call.intrinsicName === "__array_copy") {
    return {
      direct:
        parameter === 0
          ? OrdinaryParameterAccess.Write
          : OrdinaryParameterAccess.Read,
      reachable: OrdinaryParameterAccess.Unused,
    };
  }
  if (
    call.intrinsicName === "__array_get" ||
    call.intrinsicName === "__array_len" ||
    call.intrinsicName === "__ref_is_null"
  ) {
    return {
      direct:
        parameter === 0
          ? OrdinaryParameterAccess.Read
          : OrdinaryParameterAccess.Unused,
      reachable: OrdinaryParameterAccess.Unused,
    };
  }
  if (!summary) {
    const argument = indexCallArgumentFor(call, parameter);
    return {
      direct: OrdinaryParameterAccess.Unused,
      reachable:
        argument?.referenceCapable === true
          ? OrdinaryParameterAccess.Write
          : OrdinaryParameterAccess.Unused,
    };
  }
  return {
    direct:
      summary.directAccesses[parameter] ?? OrdinaryParameterAccess.Unused,
    reachable:
      summary.reachableAccesses[parameter] ?? OrdinaryParameterAccess.Unused,
  };
};

const callPreservesStagedOrder = ({
  call,
  contract,
  index,
}: {
  call: CallableBorrowIndexCall;
  contract: StagedAccess;
  index: CallableBorrowIndex;
}): boolean => {
  if (call.intrinsicName === "__array_copy") return true;
  if (
    call.openTraitDispatch ||
    call.argumentPlanAmbiguous ||
    call.targets.length !== 1
  ) {
    return false;
  }
  const forwarded = call.signature?.stagedAccess;
  if (!forwarded) return false;
  const destination = indexCallArgumentFor(
    call,
    forwarded.destinationParameterIndex,
  );
  return Boolean(
    destination &&
    callerParametersForArgument(destination, index).has(
      contract.destinationParameterIndex,
    ),
  );
};

const stagedOrderFailure = ({
  cfg,
  events,
}: {
  cfg: ReturnType<typeof buildCallableCfg>;
  events: ReadonlyMap<HirExprId, StagedEvent>;
}): { expression?: HirExprId; reason: string; workItems: number } => {
  const seen = cfg.blocks.map(() => 0);
  const pending: { block: number; destinationWritten: boolean }[] = [
    { block: cfg.entry, destinationWritten: false },
  ];
  let workItems = 0;
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor]!;
    const stateBit = current.destinationWritten ? 2 : 1;
    if ((seen[current.block]! & stateBit) !== 0) continue;
    seen[current.block] |= stateBit;
    workItems += 1;
    const expression = cfg.blocks[current.block]!.expression;
    const event = expression === undefined ? undefined : events.get(expression);
    if (event?.readsSource && current.destinationWritten) {
      return {
        expression,
        reason:
          "a reference-bearing input may be accessed after the destination is written",
        workItems,
      };
    }
    if (
      event?.readsSource &&
      event.writesDestination &&
      !event.compatibleForwarding
    ) {
      return {
        expression,
        reason:
          "a nested call that reads an input and writes the destination must declare a compatible @staged contract",
        workItems,
      };
    }
    const destinationWritten =
      current.destinationWritten || event?.writesDestination === true;
    cfg.blocks[current.block]!.successors.forEach((successor) =>
      pending.push({ block: successor, destinationWritten }),
    );
  }
  return { reason: "", workItems };
};

const sameStagedAccess = (
  left: StagedAccess,
  right: StagedAccess | undefined,
): boolean =>
  right !== undefined &&
  left.destinationParameterIndex === right.destinationParameterIndex;

const stagedDiagnostic = ({
  callable,
  reason,
  span,
}: {
  callable: string;
  reason: string;
  span: Diagnostic["span"];
}): Diagnostic =>
  diagnosticFromCode({
    code: "TY0057",
    params: { kind: "invalid-staged-contract", callable, reason },
    span,
  });

const symbolName = (symbol: SymbolId, symbolTable: SymbolTable): string =>
  symbolTable.hasSymbol(symbol)
    ? symbolTable.getSymbol(symbol).name
    : `callable#${symbol}`;

const recordStats = (stats: ValidationStats): void => {
  incrementCompilerPerfCounter("borrowing.staged.declarations", stats.declarations);
  incrementCompilerPerfCounter("borrowing.staged.cfgBlocks", stats.cfgBlocks);
  incrementCompilerPerfCounter("borrowing.staged.cfgEdges", stats.cfgEdges);
  incrementCompilerPerfCounter("borrowing.staged.facts", stats.facts);
  incrementCompilerPerfCounter("borrowing.staged.workItems", stats.workItems);
  incrementCompilerPerfCounter("borrowing.staged.forwarding", stats.forwarding);
  incrementCompilerPerfCounter("borrowing.staged.traitChecks", stats.traitChecks);
  incrementCompilerPerfCounter("borrowing.staged.violations", stats.violations);
};
