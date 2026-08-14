import { diagnosticFromCode } from "../../diagnostics/index.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import { STD_INTRINSIC_TYPE } from "../../compiler-contracts/index.js";
import type { ResultIdentity } from "../../result-identity.js";
import {
  walkExpression,
  type HirExpression,
  type HirFunction,
  type HirGraph,
  type HirPattern,
} from "../hir/index.js";
import type { Diagnostic, HirExprId, SymbolId } from "../ids.js";
import type { SymbolTable } from "../binder/index.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import { typeCanCarryReference } from "./reference-bearing.js";
import { typeHasIntrinsicRole } from "./intrinsic-type-role.js";
import type {
  CallableBorrowIndex,
  CallableBorrowIndexCall,
} from "./callable-borrow-index.js";

type ValidationStats = {
  declarations: number;
  paths: number;
  forwarding: number;
  traitChecks: number;
  violations: number;
};

type LocalResultFacts = {
  initializers: ReadonlyMap<
    SymbolId,
    { expression: HirExprId; projected: boolean }
  >;
  assigned: ReadonlySet<SymbolId>;
  mutationSources: ReadonlyMap<SymbolId, readonly HirExprId[]>;
};

export const validateResultIdentityContracts = ({
  functions,
  indexes,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
}: {
  functions: readonly HirFunction[];
  indexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
}): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const stats: ValidationStats = {
    declarations: 0,
    paths: 0,
    forwarding: 0,
    traitChecks: 0,
    violations: 0,
  };
  const inheritedContracts = new Map<SymbolId, ResultIdentity>();
  typing.traitMethodImpls.forEach((mapping, implementation) => {
    const contract = typing.traits
      .getDecl(mapping.traitSymbol)
      ?.methods.find(
        (method) => method.symbol === mapping.traitMethodSymbol,
      )?.resultIdentity;
    if (contract) inheritedContracts.set(implementation, contract);
  });
  const localFactsByFunction = new Map(
    functions.flatMap((fn) => {
      const index = indexes.get(fn.symbol);
      return index
        ? [
            [
              fn.symbol,
              collectLocalResultFacts({ body: fn.body, hir, index }),
            ] as const,
          ]
        : [];
    }),
  );
  const unsafeFreshDeclarations = collectUnsafeFreshDeclarations({
    functions,
    indexes,
    localFactsByFunction,
    inheritedContracts,
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
  });

  functions.forEach((fn) => {
    const contract = inheritedContracts.get(fn.symbol) ?? fn.resultIdentity;
    const index = indexes.get(fn.symbol);
    if (!contract || !index) return;
    stats.declarations += 1;
    const localFacts = localFactsByFunction.get(fn.symbol)!;
    const calls = new Map(index.calls.map((call) => [call.exprId, call]));
    const terminals = collectResultTerminals(fn.body, hir);
    const memo = new Map<HirExprId, { valid: boolean; forwarding: boolean }>();
    terminals.forEach((terminal) => {
      stats.paths += 1;
      const result =
        typeof terminal === "number"
          ? expressionSatisfiesContract({
              expressionId: terminal,
              contract,
              index,
              calls,
              localFacts,
              hir,
              typing,
              symbolTable,
              moduleId,
              imports,
              unsafeFreshDeclarations,
              active: new Set(),
              memo,
            })
          : { valid: false, forwarding: false };
      if (
        result.valid &&
        contract.kind === "fresh" &&
        unsafeFreshDeclarations.has(fn.symbol)
      ) {
        result.valid = false;
      }
      if (result.forwarding) stats.forwarding += 1;
      if (result.valid) return;
      stats.violations += 1;
      const span =
        typeof terminal === "number"
          ? hir.expressions.get(terminal)?.span
          : fn.span;
      diagnostics.push(
        diagnosticFromCode({
          code: "TY0056",
          params: {
            kind: "invalid-result-contract",
            contract: contract.kind,
            reason: failureReason(contract),
          },
          span: span ?? fn.span,
        }),
      );
    });
  });

  typing.traitMethodImpls.forEach((mapping, implementation) => {
    const declaration = typing.traits
      .getDecl(mapping.traitSymbol)
      ?.methods.find((method) => method.symbol === mapping.traitMethodSymbol);
    const expected = declaration?.resultIdentity;
    if (!expected) return;
    stats.traitChecks += 1;
    const actual =
      typing.functions.getSignature(implementation)?.resultIdentity;
    if (actual === undefined || sameResultIdentity(expected, actual)) return;
    stats.violations += 1;
    const fn = functions.find(
      (candidate) => candidate.symbol === implementation,
    );
    diagnostics.push(
      diagnosticFromCode({
        code: "TY0056",
        params: {
          kind: "invalid-result-contract",
          contract: expected.kind,
          reason: `trait implementation declares an incompatible '${formatResultIdentity(actual)}' contract; expected '${formatResultIdentity(expected)}'`,
        },
        span: fn?.span ?? declaration.span,
      }),
    );
  });

  incrementCompilerPerfCounter(
    "borrowing.resultIdentity.declarations",
    stats.declarations,
  );
  incrementCompilerPerfCounter("borrowing.resultIdentity.paths", stats.paths);
  incrementCompilerPerfCounter(
    "borrowing.resultIdentity.forwarding",
    stats.forwarding,
  );
  incrementCompilerPerfCounter(
    "borrowing.resultIdentity.traitChecks",
    stats.traitChecks,
  );
  incrementCompilerPerfCounter(
    "borrowing.resultIdentity.violations",
    stats.violations,
  );
  return diagnostics;
};

const collectResultTerminals = (
  body: HirExprId,
  hir: HirGraph,
): readonly (HirExprId | undefined)[] => {
  const terminals: (HirExprId | undefined)[] = [];
  walkExpression({
    exprId: body,
    hir,
    options: { skipLambdas: true },
    onEnterExpression: (expressionId, expression, context) => {
      if (!context.tailPosition) return;
      if (tailIsDelegatedToChildren(expression)) return;
      terminals.push(expressionId);
    },
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind === "return" && typeof statement.value !== "number") {
        terminals.push(undefined);
      }
    },
  });
  return terminals.length > 0 ? terminals : [undefined];
};

const tailIsDelegatedToChildren = (expression: HirExpression): boolean => {
  switch (expression.exprKind) {
    case "block":
      return typeof expression.value === "number";
    case "if":
    case "cond":
      return (
        expression.branches.length > 0 && expression.defaultBranch !== undefined
      );
    case "match":
      return expression.arms.length > 0;
    case "effect-handler":
      return true;
    default:
      return false;
  }
};

const collectLocalResultFacts = ({
  body,
  hir,
  index,
}: {
  body: HirExprId;
  hir: HirGraph;
  index: CallableBorrowIndex;
}): LocalResultFacts => {
  const initializers = new Map<
    SymbolId,
    { expression: HirExprId; projected: boolean }
  >();
  const assigned = new Set<SymbolId>();
  const mutableBindings = new Set<SymbolId>();
  const mutationSources = new Map<SymbolId, HirExprId[]>();
  const addMutationSource = (root: SymbolId, value: HirExprId) => {
    const sources = mutationSources.get(root) ?? [];
    sources.push(value);
    mutationSources.set(root, sources);
  };
  walkExpression({
    exprId: body,
    hir,
    options: { skipLambdas: true },
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind !== "let") return;
      if (statement.mutable && statement.pattern.kind !== "identifier") return;
      if (
        statement.pattern.kind !== "identifier" &&
        patternHasMutableReference(statement.pattern)
      ) {
        return;
      }
      recordPatternInitializers({
        pattern: statement.pattern,
        expression: statement.initializer,
        initializers,
      });
      if (statement.mutable && statement.pattern.kind === "identifier") {
        mutableBindings.add(statement.pattern.symbol);
      }
    },
    onEnterExpression: (_expressionId, expression) => {
      if (expression.exprKind === "match") {
        expression.arms.forEach((arm) => {
          if (patternHasMutableReference(arm.pattern)) return;
          recordPatternInitializers({
            pattern: arm.pattern,
            expression: expression.discriminant,
            initializers,
          });
        });
      }
      if (expression.exprKind !== "assign") return;
      if (typeof expression.target === "number") {
        const root = expressionRootSymbol(expression.target, hir);
        const target = hir.expressions.get(expression.target);
        if (
          target?.exprKind === "identifier" &&
          mutableBindings.has(target.symbol)
        ) {
          addMutationSource(target.symbol, expression.value);
        } else if (target?.exprKind === "identifier") {
          assigned.add(target.symbol);
        } else if (root !== undefined)
          addMutationSource(root, expression.value);
      }
      if (expression.pattern) {
        patternSymbols(expression.pattern).forEach((symbol) =>
          assigned.add(symbol),
        );
      }
    },
  });
  index.calls.forEach((call) => {
    call.arguments
      .filter(
        (argument) => argument.bindingKind === "mutable-ref" && argument.place,
      )
      .forEach((mutated) => {
        const builderDestination =
          call.signature?.builderAccess?.destinationParameterIndex;
        if (
          mutated.parameter === builderDestination &&
          call.openTraitDispatch !== true &&
          call.ordinaryDynamicBound === undefined &&
          call.argumentPlanAmbiguous !== true &&
          call.targets.length === 1 &&
          call.maySuspend !== true
        ) {
          return;
        }
        call.arguments.forEach((source) => {
          if (
            source === mutated ||
            typeof source.expression !== "number" ||
            source.place?.root === mutated.place!.root
          ) {
            return;
          }
          addMutationSource(mutated.place!.root, source.expression);
        });
      });
  });
  return { initializers, assigned, mutationSources };
};

const recordPatternInitializers = ({
  pattern,
  expression,
  initializers,
  projected = false,
}: {
  pattern: HirPattern;
  expression: HirExprId;
  initializers: Map<SymbolId, { expression: HirExprId; projected: boolean }>;
  projected?: boolean;
}): void => {
  switch (pattern.kind) {
    case "identifier":
      initializers.set(pattern.symbol, { expression, projected });
      return;
    case "tuple":
      pattern.elements.forEach((element) =>
        recordPatternInitializers({
          pattern: element,
          expression,
          initializers,
          projected: true,
        }),
      );
      return;
    case "destructure":
      pattern.fields.forEach((field) =>
        recordPatternInitializers({
          pattern: field.pattern,
          expression,
          initializers,
          projected: true,
        }),
      );
      if (pattern.spread) {
        recordPatternInitializers({
          pattern: pattern.spread,
          expression,
          initializers,
          projected: true,
        });
      }
      return;
    case "type":
      if (pattern.binding) {
        recordPatternInitializers({
          pattern: pattern.binding,
          expression,
          initializers,
          projected,
        });
      }
      return;
    case "wildcard":
      return;
  }
};

const patternHasMutableReference = (pattern: HirPattern): boolean => {
  if (pattern.bindingKind === "mutable-ref") return true;
  switch (pattern.kind) {
    case "tuple":
      return pattern.elements.some(patternHasMutableReference);
    case "destructure":
      return (
        pattern.fields.some((field) =>
          patternHasMutableReference(field.pattern),
        ) ||
        Boolean(pattern.spread && patternHasMutableReference(pattern.spread))
      );
    case "type":
      return Boolean(
        pattern.binding && patternHasMutableReference(pattern.binding),
      );
    case "identifier":
    case "wildcard":
      return false;
  }
};

const expressionRootSymbol = (
  expressionId: HirExprId,
  hir: HirGraph,
): SymbolId | undefined => {
  const expression = hir.expressions.get(expressionId);
  if (expression?.exprKind === "identifier") return expression.symbol;
  return expression?.exprKind === "field-access"
    ? expressionRootSymbol(expression.target, hir)
    : undefined;
};

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

const collectUnsafeFreshDeclarations = ({
  functions,
  indexes,
  localFactsByFunction,
  inheritedContracts,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
}: {
  functions: readonly HirFunction[];
  indexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  localFactsByFunction: ReadonlyMap<SymbolId, LocalResultFacts>;
  inheritedContracts: ReadonlyMap<SymbolId, ResultIdentity>;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
}): ReadonlySet<SymbolId> => {
  const functionsBySymbol = new Map(functions.map((fn) => [fn.symbol, fn]));
  const callsByFunction = new Map(
    Array.from(indexes, ([symbol, index]) => [
      symbol,
      new Map(index.calls.map((call) => [call.exprId, call])),
    ]),
  );
  const safetyByFunction = new Map<SymbolId, boolean>();
  const activeFunctions = new Set<SymbolId>();
  const effectiveContract = (fn: HirFunction): ResultIdentity | undefined =>
    inheritedContracts.get(fn.symbol) ?? fn.resultIdentity;
  const callableResultIsSafe = (symbol: SymbolId): boolean => {
    const cached = safetyByFunction.get(symbol);
    if (cached !== undefined) return cached;
    if (activeFunctions.has(symbol)) return false;
    const fn = functionsBySymbol.get(symbol);
    const index = indexes.get(symbol);
    const localFacts = localFactsByFunction.get(symbol);
    const calls = callsByFunction.get(symbol);
    if (!fn || !index || !localFacts || !calls) {
      return false;
    }
    activeFunctions.add(symbol);
    const expressionMemo = new Map<HirExprId, boolean>();
    const expressionIsSafe = (
      expressionId: HirExprId,
      activeExpressions = new Set<HirExprId>(),
    ): boolean => {
      const memoized = expressionMemo.get(expressionId);
      if (memoized !== undefined) return memoized;
      if (activeExpressions.has(expressionId)) return false;
      const expression = hir.expressions.get(expressionId);
      if (!expression) return false;
      const nextActive = new Set(activeExpressions).add(expressionId);
      const type =
        typing.resolvedExprTypes.get(expressionId) ??
        typing.borrowResolvedExprTypes.get(expressionId);
      if (typeof type === "number" && !typeCanCarryReference(type, typing)) {
        expressionMemo.set(expressionId, true);
        return true;
      }
      if (
        [STD_INTRINSIC_TYPE.string, STD_INTRINSIC_TYPE.stringSlice].some(
          (role) =>
            typeHasIntrinsicRole({
              type,
              role,
              typing,
              symbolTable,
              moduleId,
              imports,
            }),
        )
      ) {
        expressionMemo.set(expressionId, true);
        return true;
      }
      const recurse = (child: HirExprId): boolean =>
        expressionIsSafe(child, nextActive);
      let safe: boolean;
      switch (expression.exprKind) {
        case "literal":
          safe = true;
          break;
        case "identifier": {
          if (
            index.parameters.some(
              (parameter) => parameter.symbol === expression.symbol,
            )
          ) {
            safe = true;
            break;
          }
          const binding = localFacts.assigned.has(expression.symbol)
            ? undefined
            : localFacts.initializers.get(expression.symbol);
          safe = Boolean(
            binding &&
            recurse(binding.expression) &&
            (localFacts.mutationSources.get(expression.symbol) ?? []).every(
              recurse,
            ),
          );
          break;
        }
        case "object-literal":
          safe = expression.entries.every((entry) => recurse(entry.value));
          break;
        case "tuple":
          safe = expression.elements.every(recurse);
          break;
        case "field-access":
          safe = recurse(expression.target);
          break;
        case "block":
          safe =
            typeof expression.value === "number" && recurse(expression.value);
          break;
        case "if":
        case "cond":
          safe =
            expression.branches.every((branch) => recurse(branch.value)) &&
            typeof expression.defaultBranch === "number" &&
            recurse(expression.defaultBranch);
          break;
        case "match":
          safe =
            expression.arms.length > 0 &&
            expression.arms.every((arm) => recurse(arm.value));
          break;
        case "call":
        case "method-call": {
          const call = calls.get(expressionId);
          const declared =
            call?.resultIdentity ?? call?.signature?.resultIdentity;
          if (!call) {
            safe = false;
            break;
          }
          if (declared?.kind === "detached") {
            safe = true;
            break;
          }
          const argumentsAreSafe = call.arguments.every(
            (argument) =>
              argument.referenceCapable !== true ||
              (typeof argument.expression === "number" &&
                recurse(argument.expression)),
          );
          if (declared?.kind === "fresh") {
            safe =
              argumentsAreSafe &&
              call.targets.every((target) => {
                if (target.moduleId !== moduleId) return true;
                const targetFunction = functionsBySymbol.get(target.symbol);
                return !targetFunction || callableResultIsSafe(target.symbol);
              });
            break;
          }
          if (declared?.kind === "same-place") {
            const forwarded = call.arguments.find(
              (argument) => argument.parameter === declared.parameterIndex,
            );
            safe = Boolean(
              forwarded &&
              typeof forwarded.expression === "number" &&
              recurse(forwarded.expression),
            );
            break;
          }
          safe = Boolean(
            (call.ordinaryMutationFreeConstruction ||
              call.intrinsicName === "~" ||
              call.intrinsicName === "__array_get" ||
              call.intrinsicName === "__array_copy" ||
              call.intrinsicName === "__array_new" ||
              call.intrinsicName === "__array_new_fixed") &&
            argumentsAreSafe,
          );
          if (safe) break;
          const exactLocalTarget =
            call.openTraitDispatch !== true &&
            call.ordinaryDynamicBound === undefined &&
            call.argumentPlanAmbiguous !== true &&
            call.targets.length === 1 &&
            call.targets[0]?.moduleId === moduleId
              ? functionsBySymbol.get(call.targets[0].symbol)
              : undefined;
          safe = Boolean(
            exactLocalTarget &&
            argumentsAreSafe &&
            callableResultIsSafe(exactLocalTarget.symbol),
          );
          break;
        }
        case "overload-set":
        case "loop":
        case "while":
        case "lambda":
        case "effect-handler":
        case "assign":
        case "break":
        case "continue":
          safe = false;
          break;
      }
      expressionMemo.set(expressionId, safe);
      return safe;
    };
    const safe = collectResultTerminals(fn.body, hir).every(
      (terminal) => typeof terminal === "number" && expressionIsSafe(terminal),
    );
    activeFunctions.delete(symbol);
    safetyByFunction.set(symbol, safe);
    return safe;
  };

  return new Set(
    functions.flatMap((fn) =>
      effectiveContract(fn)?.kind === "fresh" &&
      !callableResultIsSafe(fn.symbol)
        ? [fn.symbol]
        : [],
    ),
  );
};

const expressionSatisfiesContract = ({
  expressionId,
  contract,
  index,
  calls,
  localFacts,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  unsafeFreshDeclarations,
  active,
  memo,
}: {
  expressionId: HirExprId;
  contract: ResultIdentity;
  index: CallableBorrowIndex;
  calls: ReadonlyMap<HirExprId, CallableBorrowIndexCall>;
  localFacts: LocalResultFacts;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  unsafeFreshDeclarations: ReadonlySet<SymbolId>;
  active: Set<HirExprId>;
  memo: Map<HirExprId, { valid: boolean; forwarding: boolean }>;
}): { valid: boolean; forwarding: boolean } => {
  const cached = memo.get(expressionId);
  if (cached) return cached;
  if (active.has(expressionId)) return { valid: false, forwarding: false };
  active.add(expressionId);
  const expression = hir.expressions.get(expressionId);
  if (!expression) return { valid: false, forwarding: false };
  const finish = (result: { valid: boolean; forwarding: boolean }) => {
    memo.set(expressionId, result);
    return result;
  };

  if (contract.kind === "same-place") {
    const direct = exactParameterExpression({ expression, contract, index });
    if (direct) {
      return finish({
        valid: !index.rootReboundParameters.has(contract.parameterIndex),
        forwarding: false,
      });
    }
    const call = calls.get(expressionId);
    return finish({
      valid: Boolean(
        call && samePlaceForwardingMatches({ call, contract, index }),
      ),
      forwarding: Boolean(call),
    });
  }

  const type =
    typing.resolvedExprTypes.get(expressionId) ??
    typing.borrowResolvedExprTypes.get(expressionId);
  if (typeof type === "number" && !typeCanCarryReference(type, typing)) {
    return finish({ valid: true, forwarding: false });
  }
  if (
    contract.kind === "detached" &&
    typeHasIntrinsicRole({
      type,
      role: STD_INTRINSIC_TYPE.stringSlice,
      typing,
      symbolTable,
      moduleId,
      imports,
    })
  ) {
    return finish({ valid: true, forwarding: false });
  }
  if (expression.exprKind === "literal") {
    return finish({ valid: true, forwarding: false });
  }
  if (expression.exprKind === "identifier") {
    const binding = localFacts.assigned.has(expression.symbol)
      ? undefined
      : localFacts.initializers.get(expression.symbol);
    if (!binding || (contract.kind === "fresh" && binding.projected)) {
      return finish({ valid: false, forwarding: false });
    }
    const initialized = expressionSatisfiesContract({
      expressionId: binding.expression,
      contract,
      index,
      calls,
      localFacts,
      hir,
      typing,
      symbolTable,
      moduleId,
      imports,
      unsafeFreshDeclarations,
      active,
      memo,
    });
    if (!initialized.valid || contract.kind !== "detached") {
      return finish(initialized);
    }
    const mutationSources =
      localFacts.mutationSources.get(expression.symbol) ?? [];
    const mutationsAreDetached = mutationSources.every(
      (source) =>
        expressionSatisfiesContract({
          expressionId: source,
          contract,
          index,
          calls,
          localFacts,
          hir,
          typing,
          symbolTable,
          moduleId,
          imports,
          unsafeFreshDeclarations,
          active: new Set(active),
          memo,
        }).valid,
    );
    return finish({
      valid: mutationsAreDetached,
      forwarding: initialized.forwarding,
    });
  }
  const call = calls.get(expressionId);
  if (call) {
    const declared = call.resultIdentity ?? call.signature?.resultIdentity;
    if (declared?.kind === contract.kind) {
      return finish({ valid: true, forwarding: true });
    }
    if (
      contract.kind === "detached" &&
      declared?.kind === "fresh" &&
      !call.targets.some(
        (target) =>
          target.moduleId === moduleId &&
          unsafeFreshDeclarations.has(target.symbol),
      ) &&
      call.arguments.every(
        (argument) =>
          typeof argument.expression !== "number" ||
          expressionSatisfiesContract({
            expressionId: argument.expression,
            contract,
            index,
            calls,
            localFacts,
            hir,
            typing,
            symbolTable,
            moduleId,
            imports,
            unsafeFreshDeclarations,
            active: new Set(active),
            memo,
          }).valid,
      )
    ) {
      return finish({ valid: true, forwarding: true });
    }
    const compilerKnownFreshConstruction =
      call.ordinaryMutationFreeConstruction ||
      call.intrinsicName === "__array_new" ||
      call.intrinsicName === "__array_new_fixed";
    if (contract.kind === "fresh" && compilerKnownFreshConstruction) {
      return finish({ valid: true, forwarding: false });
    }
    if (
      contract.kind === "detached" &&
      compilerKnownFreshConstruction &&
      call.arguments.every(
        (argument) =>
          typeof argument.expression !== "number" ||
          expressionSatisfiesContract({
            expressionId: argument.expression,
            contract,
            index,
            calls,
            localFacts,
            hir,
            typing,
            symbolTable,
            moduleId,
            imports,
            unsafeFreshDeclarations,
            active: new Set(active),
            memo,
          }).valid,
      )
    ) {
      return finish({ valid: true, forwarding: false });
    }
    return finish({ valid: false, forwarding: false });
  }
  if (expression.exprKind === "object-literal") {
    if (contract.kind === "fresh") {
      return finish({ valid: true, forwarding: false });
    }
    return finish({
      valid: expression.entries.every(
        (entry) =>
          expressionSatisfiesContract({
            expressionId: entry.value,
            contract,
            index,
            calls,
            localFacts,
            hir,
            typing,
            symbolTable,
            moduleId,
            imports,
            unsafeFreshDeclarations,
            active: new Set(active),
            memo,
          }).valid,
      ),
      forwarding: false,
    });
  }
  if (expression.exprKind === "tuple") {
    if (contract.kind === "fresh") {
      return finish({ valid: true, forwarding: false });
    }
    return finish({
      valid: expression.elements.every(
        (element) =>
          expressionSatisfiesContract({
            expressionId: element,
            contract,
            index,
            calls,
            localFacts,
            hir,
            typing,
            symbolTable,
            moduleId,
            imports,
            unsafeFreshDeclarations,
            active: new Set(active),
            memo,
          }).valid,
      ),
      forwarding: false,
    });
  }
  return finish({ valid: false, forwarding: false });
};

const exactParameterExpression = ({
  expression,
  contract,
  index,
}: {
  expression: HirExpression;
  contract: Extract<ResultIdentity, { kind: "same-place" }>;
  index: CallableBorrowIndex;
}): boolean =>
  expression.exprKind === "identifier" &&
  expression.symbol === index.parameters[contract.parameterIndex]?.symbol;

const samePlaceForwardingMatches = ({
  call,
  contract,
  index,
}: {
  call: CallableBorrowIndexCall;
  contract: Extract<ResultIdentity, { kind: "same-place" }>;
  index: CallableBorrowIndex;
}): boolean => {
  const forwarded = call.resultIdentity ?? call.signature?.resultIdentity;
  if (forwarded?.kind !== "same-place") return false;
  const argument = call.arguments.find(
    (candidate) => candidate.parameter === forwarded.parameterIndex,
  );
  const expected = index.parameters[contract.parameterIndex];
  return Boolean(
    argument?.place &&
    expected &&
    argument.place.root === expected.symbol &&
    argument.place.projections.every(
      (projection) => projection.kind === "identity",
    ) &&
    !index.rootReboundParameters.has(contract.parameterIndex),
  );
};

const failureReason = (contract: ResultIdentity): string => {
  switch (contract.kind) {
    case "detached":
      return "every result path must produce detached data, a stable StringSlice, or call another detached declaration";
    case "fresh":
      return "every result path must construct a fresh outer value or call another fresh declaration";
    case "same-place":
      return `every result path must return mutable parameter ${contract.parameterIndex + 1} directly or through matching same-place forwarding`;
  }
};

const sameResultIdentity = (
  left: ResultIdentity,
  right: ResultIdentity | undefined,
): boolean =>
  left.kind === right?.kind &&
  (left.kind !== "same-place" ||
    (right.kind === "same-place" &&
      left.parameterIndex === right.parameterIndex));

const formatResultIdentity = (contract: ResultIdentity): string =>
  contract.kind === "same-place"
    ? `same-place parameter ${contract.parameterIndex + 1}`
    : contract.kind;
