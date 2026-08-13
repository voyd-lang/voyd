import {
  diagnosticFromCode,
  type Diagnostic,
} from "../../diagnostics/index.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import type { SymbolTable } from "../binder/index.js";
import {
  walkExpression,
  type HirExpression,
  type HirGraph,
  type HirPattern,
} from "../hir/index.js";
import type { HirExprId, SourceSpan, SymbolId, TypeId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import { expressionTypeFor, type ResolveContext } from "./call-resolution.js";
import {
  indexCallArgumentFor,
  type CallableBorrowIndex,
  type CallableBorrowIndexCall,
} from "./callable-borrow-index.js";
import type {
  BorrowPlace,
  PlaceProjection,
  RuntimeIdentityGuard,
} from "./model.js";
import { projectionPathsOverlap } from "./model.js";
import {
  applyExactLocalCallbackHazards,
  joinOrdinaryMutationSummaries,
  ordinaryMutationDynamicBoundSummary,
  OrdinaryParameterAccess,
  ordinaryMutationSignatureUpperBound,
  type OrdinaryMutationSummary,
} from "./ordinary-mutation-summary.js";
import { placeOfExpression } from "./places.js";
import { analyzeOrdinaryMutationLiveness } from "./ordinary-mutation-liveness.js";
import {
  typeCanCarryReference,
  typeIsAllocationBacked,
} from "./reference-bearing.js";

type LocalResultAliasOrigin = {
  source: BorrowPlace;
  targetPath: readonly PlaceProjection[];
  formation: number;
  scopeRoot?: HirExprId;
};

export const checkOrdinaryLocalMutationSafety = ({
  body,
  callableSpan,
  index,
  hir,
  typing,
  symbolTable,
  resolveContext,
  moduleId,
  localSummaries,
  importedSummaries,
  plannedGuards,
}: {
  body: HirExprId;
  callableSpan: SourceSpan;
  index: CallableBorrowIndex;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  resolveContext: ResolveContext;
  moduleId: string;
  localSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  importedSummaries: ReadonlyMap<string, OrdinaryMutationSummary>;
  plannedGuards: ReadonlyMap<number, readonly RuntimeIdentityGuard[]>;
}): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const liveness = analyzeOrdinaryMutationLiveness({
    body,
    index,
    hir,
    resolveContext,
  });
  const positionByExpression = new Map<HirExprId, number>();
  const parentByExpression = new Map<HirExprId, HirExprId>();
  const returnedExpressions = new Set<HirExprId>();
  const mutablyAssignedPlaceExpressions = new Set<HirExprId>();
  const places = new Map<HirExprId, BorrowPlace>();
  const mutableBindings: {
    symbol: SymbolId;
    source: BorrowPlace;
    initializer: HirExprId;
    span: SourceSpan;
  }[] = [];
  const letBindings: {
    pattern: HirPattern;
    initializer: HirExprId;
  }[] = [];
  const lambdas: {
    captures: readonly { symbol: SymbolId }[];
    span: SourceSpan;
  }[] = [];
  let nextPosition = 0;

  walkExpression({
    exprId: body,
    hir,
    options: { skipLambdas: true },
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind !== "let") return;
      letBindings.push({
        pattern: statement.pattern,
        initializer: statement.initializer,
      });
      const symbols = mutableReferencePatternSymbols(statement.pattern);
      if (symbols.length === 0) return;
      const initializer = placeOfExpression(
        statement.initializer,
        hir,
        resolveContext,
      );
      symbols.forEach((symbol) =>
        mutableBindings.push({
          symbol,
          source: initializer ?? { root: symbol, projections: [] },
          initializer: statement.initializer,
          span: statement.span,
        }),
      );
    },
    onEnterExpression: (expressionId, expression, context) => {
      if (typeof context.parent === "number") {
        parentByExpression.set(expressionId, context.parent);
      }
      const place = placeOfExpression(expressionId, hir, resolveContext);
      if (place) places.set(expressionId, place);
      if (context.tailPosition || context.statement?.kind === "return") {
        returnedExpressions.add(expressionId);
      }
      if (expression.exprKind === "lambda") {
        lambdas.push({ captures: expression.captures, span: expression.span });
      }
      if (
        expression.exprKind === "assign" &&
        typeof expression.target === "number"
      ) {
        mutablyAssignedPlaceExpressions.add(expression.target);
      }
    },
    onExitExpression: (expressionId) => {
      positionByExpression.set(expressionId, nextPosition);
      nextPosition += 1;
    },
  });

  const aliases = new Map(
    mutableBindings.map((binding) => [binding.symbol, binding.source]),
  );
  const resolvePlace = (place: BorrowPlace): BorrowPlace => {
    let current = place;
    const seen = new Set<SymbolId>();
    while (aliases.has(current.root) && !seen.has(current.root)) {
      seen.add(current.root);
      const source = aliases.get(current.root)!;
      current = {
        root: source.root,
        projections: [...source.projections, ...current.projections],
      };
    }
    return current;
  };
  const assignedCallerOrigins = collectAssignedCallerOrigins({
    body,
    index,
    hir,
    typing,
    resolveContext,
  });

  const mutableRoots = new Set(mutableBindings.map(({ symbol }) => symbol));
  const capturedMutable = lambdas.flatMap((lambda) =>
    lambda.captures.flatMap((capture) =>
      mutableRoots.has(capture.symbol)
        ? [{ lambda, symbol: capture.symbol }]
        : [],
    ),
  );
  capturedMutable.forEach(({ lambda, symbol }) => {
    diagnostics.push(
      diagnosticFromCode({
        code: "TY0049",
        params: {
          kind: "mutable-borrow-escape",
          binding: symbolName(symbol, symbolTable),
          through: "a closure capture",
        },
        span: lambda.span,
        related: [
          diagnosticFromCode({
            code: "TY0049",
            params: {
              kind: "borrow-declaration",
              binding: symbolName(symbol, symbolTable),
            },
            span:
              mutableBindings.find((binding) => binding.symbol === symbol)
                ?.span ?? callableSpan,
            severity: "note",
          }),
        ],
      }),
    );
  });

  mutableBindings.forEach((binding) => {
    if (binding.source.root === binding.symbol) return;
    const formation = positionByExpression.get(binding.initializer) ?? -1;
    const aliasUses = Array.from(places).filter(
      ([expressionId, place]) =>
        place.root === binding.symbol && expressionId !== binding.initializer,
    );
    const lastUse = Math.max(
      formation,
      ...aliasUses.map(
        ([expressionId]) => positionByExpression.get(expressionId) ?? formation,
      ),
    );
    if (lastUse <= formation) return;
    const conflicting = Array.from(places).find(([expressionId, place]) => {
      const position = positionByExpression.get(expressionId) ?? -1;
      if (
        position <= formation ||
        position > lastUse ||
        place.root === binding.symbol ||
        expressionId === binding.initializer ||
        isProjectionTargetExpression({
          expressionId,
          places,
          parentByExpression,
        })
      ) {
        return false;
      }
      const resolved = resolvePlace(place);
      return (
        resolved.root === binding.source.root &&
        projectionPathsOverlap(
          resolved.projections,
          resolvePlace(binding.source).projections,
        )
      );
    });
    if (!conflicting) return;
    diagnostics.push(
      conflictDiagnostic({
        span: hir.expressions.get(conflicting[0])?.span ?? binding.span,
        mutablePlace: displayPlace(binding.source, symbolTable),
        existingPlace: symbolName(binding.symbol, symbolTable),
      }),
    );
  });

  const mutableParameters = index.parameters.filter(
    (parameter) => parameter.bindingKind === "mutable-ref",
  );
  const ambientRoots = new Set(index.directAmbientObjectRoots);
  const directAmbientHazard = Array.from(places).find(([expression, place]) => {
    if (!ambientRoots.has(place.root)) return false;
    const liveMutableParameters = liveness
      .liveCapabilitiesAfter(expression)
      .flatMap((capability) => mutableParameters[capability] ?? []);
    return (
      liveMutableParameters.length > 0 &&
      ambientRootMayOverlap({
        root: place.root,
        index,
        typing,
        mutableParameters: liveMutableParameters,
      })
    );
  });
  if (directAmbientHazard) {
    diagnostics.push(
      diagnosticFromCode({
        code: "TY0055",
        params: {
          kind: "ordinary-ambient-access",
          callable: symbolName(index.symbol, symbolTable),
        },
        span: hir.expressions.get(directAmbientHazard[0])?.span ?? callableSpan,
      }),
    );
  }
  index.calls.forEach((call) => {
    const summary = summaryForCall({
      call,
      moduleId,
      localSummaries,
      importedSummaries,
    });
    if (
      call.scopedSharedCellAccess !== true &&
      call.formsExplicitBorrow !== true &&
      (call.intrinsic !== true || call.maySuspend) &&
      liveness.hasLiveCapabilityAfter(call.exprId)
    ) {
      const hazardKind =
        call.maySuspend || summary?.maySuspend === true
          ? ("ordinary-suspension" as const)
          : summary?.reentrant === true || callHasUncertainDispatch(call)
            ? ("ordinary-unknown-callback" as const)
            : summary !== undefined &&
                summary.ambientAccess !== OrdinaryParameterAccess.Unused
              ? ("ordinary-ambient-access" as const)
              : undefined;
      if (hazardKind) {
        diagnostics.push(
          diagnosticFromCode({
            code: "TY0055",
            params: {
              kind: hazardKind,
              callable: symbolName(index.symbol, symbolTable),
            },
            span: call.span,
          }),
        );
      }
    }
    if (!summary) return;
    mutableParameters.forEach((mutableParameter) => {
      const mutablePlace: BorrowPlace = {
        root: mutableParameter.symbol,
        projections: [],
      };
      summary.reachableAccesses.forEach((reachableAccess, parameter) => {
        const access = Math.max(
          reachableAccess,
          summary.directAccesses[parameter] ?? OrdinaryParameterAccess.Unused,
        ) as OrdinaryParameterAccess;
        if (access === OrdinaryParameterAccess.Unused) return;
        const argument = indexCallArgumentFor(call, parameter);
        if (!argument) return;
        const argumentPlace = argument.place
          ? resolvePlace(argument.place)
          : undefined;
        if (argumentPlace?.root === mutableParameter.symbol) return;
        if (
          callAccessHasPlannedGuard({
            call,
            argument,
            mutableParameter: mutableParameter.symbol,
            resolvePlace,
            plannedGuards,
          })
        ) {
          return;
        }
        const reachesMutableParameter =
          argument.callerParameterOrigins?.includes(
            mutableParameter.parameter,
          ) === true ||
          (argumentPlace !== undefined &&
            assignedCallerOrigins
              .get(argumentPlace.root)
              ?.has(mutableParameter.parameter) === true);
        if (!reachesMutableParameter) {
          if (!callHasUncertainDispatch(call) || !argumentPlace) return;
          if (
            !typesMayShareAllocation(
              mutableParameter.type,
              argument.type,
              typing,
            )
          ) {
            return;
          }
        }
        if (callHasUncertainDispatch(call)) {
          diagnostics.push(
            conflictDiagnostic({
              span: call.span,
              mutablePlace: displayPlace(mutablePlace, symbolTable),
              existingPlace: argumentPlace
                ? displayPlace(argumentPlace, symbolTable)
                : "an argument reachable from the exclusive parameter",
              existing:
                access === OrdinaryParameterAccess.Write ? "mutable" : "shared",
            }),
          );
        }
      });

      if (!callResultMayCarryReference(call, typing)) return;
      if (callResultIsIndependentStableHandle(call, typing, symbolTable)) {
        return;
      }
      const borrowedArguments = call.arguments.filter((argument) => {
        if (!argument.place || argument.referenceCapable !== true) return false;
        const place = resolvePlace(argument.place);
        return place.root === mutableParameter.symbol;
      });
      const resultPlace = places.get(call.exprId);
      const resolvedResultPlace = resultPlace
        ? resolvePlace(resultPlace)
        : undefined;
      const borrowedPlaces =
        resolvedResultPlace?.root === mutableParameter.symbol
          ? [resolvedResultPlace]
          : borrowedArguments.flatMap((argument) =>
              argument.place ? [resolvePlace(argument.place)] : [],
            );
      if (borrowedPlaces.length === 0 || call.resultUse === "ignored") return;
      const returnType = call.signature?.returnType;
      if (
        typeof returnType === "number" &&
        borrowedArguments.every(
          (argument) =>
            typeof argument.type === "number" &&
            !typesMayShareReachableIdentity(returnType, argument.type, typing),
        )
      ) {
        return;
      }
      if (returnedExpressions.has(call.exprId)) return;
      const callPosition = positionByExpression.get(call.exprId) ?? -1;
      const laterParentUse = Array.from(places).some(
        ([expressionId, place]) => {
          if (
            (positionByExpression.get(expressionId) ?? -1) <= callPosition ||
            isDescendantOf(expressionId, call.exprId, parentByExpression) ||
            !mutablyAssignedPlaceExpressions.has(expressionId)
          ) {
            return false;
          }
          const resolved = resolvePlace(place);
          return borrowedPlaces.some(
            (borrowed) =>
              resolved.root === borrowed.root &&
              projectionPathsOverlap(
                resolved.projections,
                borrowed.projections,
              ),
          );
        },
      );
      if (!laterParentUse) return;
      diagnostics.push(
        conflictDiagnostic({
          span: call.span,
          mutablePlace: displayPlace(mutablePlace, symbolTable),
          existingPlace: "the reference-bearing call result",
          existing: "shared",
        }),
      );
    });
  });

  const callsByExpression = new Map(
    index.calls.map((call) => [call.exprId, call]),
  );
  const resultAliasOriginsBySymbol = new Map<
    SymbolId,
    readonly LocalResultAliasOrigin[]
  >();
  let changedResultAliasSymbols: Set<SymbolId> | undefined;
  const expressionCanCarryResultAlias = (expression: HirExprId): boolean => {
    const type = expressionTypeFor(expression, resolveContext);
    return typeof type !== "number" || typeCanCarryReference(type, typing);
  };
  const callResultAliasOrigins = (
    call: CallableBorrowIndexCall,
  ): readonly LocalResultAliasOrigin[] => {
    if (
      call.resultUse === "ignored" ||
      call.ordinaryMutationFreeConstruction === true ||
      !callResultMayCarryReference(call, typing) ||
      callResultIsIndependentStableHandle(call, typing, symbolTable)
    ) {
      return [];
    }
    const returnType = call.signature?.returnType;
    return mutableParameters.flatMap((mutableParameter) => {
      const sourceArguments = call.arguments.filter((argument) => {
        if (argument.referenceCapable !== true) return false;
        if (
          argument.place &&
          resultAliasOriginsBySymbol.has(argument.place.root)
        ) {
          return false;
        }
        if (
          typeof returnType === "number" &&
          typeof argument.type === "number" &&
          !typesMayShareReachableIdentity(returnType, argument.type, typing)
        ) {
          return false;
        }
        return (
          (argument.place !== undefined &&
            resolvePlace(argument.place).root === mutableParameter.symbol) ||
          argument.callerParameterOrigins?.includes(
            mutableParameter.parameter,
          ) === true ||
          (argument.place !== undefined &&
            assignedCallerOrigins
              .get(argument.place.root)
              ?.has(mutableParameter.parameter) === true)
        );
      });
      const localResultPlace = places.get(call.exprId);
      const resolvedLocalResultPlace = localResultPlace
        ? resolvePlace(localResultPlace)
        : undefined;
      const sources =
        sourceArguments.length > 0 &&
        resolvedLocalResultPlace?.root === mutableParameter.symbol
          ? [resolvedLocalResultPlace]
          : sourceArguments.flatMap((argument) => {
              if (argument.place) {
                const place = resolvePlace(argument.place);
                if (place.root === mutableParameter.symbol) return [place];
              }
              return argument.callerParameterOrigins?.includes(
                mutableParameter.parameter,
              ) ||
                (argument.place !== undefined &&
                  assignedCallerOrigins
                    .get(argument.place.root)
                    ?.has(mutableParameter.parameter))
                ? [{ root: mutableParameter.symbol, projections: [] }]
                : [];
            });
      const intrinsicSources =
        call.intrinsicName === "__array_get" && call.intrinsicIndex
          ? sources.map((source) => ({
              root: source.root,
              projections: [
                ...source.projections,
                call.intrinsicIndex!,
                { kind: "dereference" as const },
              ],
            }))
          : sources;
      return intrinsicSources.map((source) => ({
        source,
        targetPath: [],
        formation: positionByExpression.get(call.exprId) ?? -1,
      }));
    });
  };
  let resultAliasExpressionCache = new Map<
    HirExprId,
    readonly LocalResultAliasOrigin[]
  >();
  const resultAliasOriginsOf = (
    expressionId: HirExprId,
  ): readonly LocalResultAliasOrigin[] => {
    const cached = resultAliasExpressionCache.get(expressionId);
    if (cached) return cached;
    const expression = hir.expressions.get(expressionId);
    if (!expression || !expressionCanCarryResultAlias(expressionId)) {
      return [];
    }
    const origins = localResultAliasOriginsForExpression({
      expression,
      originsBySymbol: resultAliasOriginsBySymbol,
      originsOf: resultAliasOriginsOf,
      callsByExpression,
      callOrigins: callResultAliasOrigins,
      callCanCarryOrigin: (call) =>
        call.resultUse !== "ignored" &&
        call.ordinaryMutationFreeConstruction !== true &&
        callResultMayCarryReference(call, typing) &&
        !callResultIsIndependentStableHandle(call, typing, symbolTable),
      callArgumentCanCarryOrigin: (call, argument) => {
        const returnType = call.signature?.returnType;
        return (
          typeof returnType !== "number" ||
          typeof argument.type !== "number" ||
          typesMayShareReachableIdentity(returnType, argument.type, typing)
        );
      },
      hir,
    });
    const distinct = distinctResultAliasOrigins(origins);
    resultAliasExpressionCache.set(expressionId, distinct);
    return distinct;
  };
  const addResultAliasOrigins = (
    symbol: SymbolId,
    origins: readonly LocalResultAliasOrigin[],
  ): boolean => {
    const type = typing.valueTypes.get(symbol);
    if (
      origins.length === 0 ||
      (typeof type === "number" && !typeCanCarryReference(type, typing))
    ) {
      return false;
    }
    const current = resultAliasOriginsBySymbol.get(symbol) ?? [];
    const merged = widenResultAliasOrigins([...current, ...origins]);
    if (resultAliasOriginSetsEqual(current, merged)) return false;
    resultAliasOriginsBySymbol.set(symbol, merged);
    changedResultAliasSymbols?.add(symbol);
    return true;
  };
  const bindResultAliasPattern = ({
    pattern,
    origins,
  }: {
    pattern: HirPattern;
    origins: readonly LocalResultAliasOrigin[];
  }): boolean => {
    switch (pattern.kind) {
      case "identifier":
        return addResultAliasOrigins(pattern.symbol, origins);
      case "tuple":
        return pattern.elements
          .map((element, index) =>
            bindResultAliasPattern({
              pattern: element,
              origins: selectResultAliasProjection(origins, {
                kind: "tuple",
                index,
              }),
            }),
          )
          .some(Boolean);
      case "destructure": {
        const fieldChanged = pattern.fields
          .map((field) =>
            bindResultAliasPattern({
              pattern: field.pattern,
              origins: selectResultAliasProjection(origins, {
                kind: "field",
                name: field.name,
              }),
            }),
          )
          .some(Boolean);
        const spreadChanged = pattern.spread
          ? bindResultAliasPattern({ pattern: pattern.spread, origins })
          : false;
        return fieldChanged || spreadChanged;
      }
      case "type":
        return pattern.binding
          ? bindResultAliasPattern({ pattern: pattern.binding, origins })
          : false;
      case "wildcard":
        return false;
    }
  };
  const mutableParameterSymbols = new Set(
    mutableParameters.map((parameter) => parameter.symbol),
  );
  const resultAliasTransfers: {
    position: number;
    dependencies: ReadonlySet<SymbolId>;
    apply: () => void;
  }[] = letBindings.map((binding) => ({
    position: positionByExpression.get(binding.initializer) ?? -1,
    dependencies: referencedSymbols(binding.initializer, hir),
    apply: () =>
      void bindResultAliasPattern({
        pattern: binding.pattern,
        origins: resultAliasOriginsOf(binding.initializer),
      }),
  }));
  const resultAliasCandidateSymbols = new Set(
    letBindings.flatMap((binding) => patternSymbols(binding.pattern)),
  );
  walkExpression({
    exprId: body,
    hir,
    options: { skipLambdas: true },
    onExitExpression: (expressionId, expression) => {
      if (expression.exprKind === "match") {
        expression.arms.forEach((arm) => {
          patternSymbols(arm.pattern).forEach((symbol) =>
            resultAliasCandidateSymbols.add(symbol),
          );
        });
        resultAliasTransfers.push({
          position: positionByExpression.get(expressionId) ?? -1,
          dependencies: referencedSymbols(expression.discriminant, hir),
          apply: () => {
            const discriminantOrigins = resultAliasOriginsOf(
              expression.discriminant,
            );
            expression.arms.forEach((arm) => {
              bindResultAliasPattern({
                pattern: arm.pattern,
                origins: discriminantOrigins.map((origin) => ({
                  ...origin,
                  scopeRoot: arm.value,
                })),
              });
            });
          },
        });
        return;
      }
      if (expression.exprKind !== "assign") return;
      const target =
        typeof expression.target === "number"
          ? placeOfExpression(expression.target, hir, resolveContext)
          : undefined;
      if (expression.pattern) {
        patternSymbols(expression.pattern).forEach((symbol) =>
          resultAliasCandidateSymbols.add(symbol),
        );
      }
      if (target && !mutableParameterSymbols.has(target.root)) {
        resultAliasCandidateSymbols.add(target.root);
      }
      resultAliasTransfers.push({
        position: positionByExpression.get(expressionId) ?? -1,
        dependencies: referencedSymbols(expression.value, hir),
        apply: () => {
          const valueOrigins = resultAliasOriginsOf(expression.value);
          if (expression.pattern) {
            bindResultAliasPattern({
              pattern: expression.pattern,
              origins: valueOrigins,
            });
          }
          if (!target || mutableParameterSymbols.has(target.root)) return;
          addResultAliasOrigins(
            target.root,
            valueOrigins.map((origin) => ({
              ...origin,
              targetPath: [
                ...target.projections.filter(
                  (projection) => projection.kind !== "dereference",
                ),
                ...origin.targetPath,
              ],
            })),
          );
        },
      });
    },
  });
  resultAliasTransfers.sort((left, right) => left.position - right.position);
  incrementCompilerPerfCounter(
    "borrowing.ordinaryLocal.resultAliasTransfers",
    resultAliasTransfers.length,
  );
  const transfersByDependency = new Map<SymbolId, number[]>();
  resultAliasTransfers.forEach((transfer, transferIndex) =>
    transfer.dependencies.forEach((symbol) => {
      const dependents = transfersByDependency.get(symbol) ?? [];
      dependents.push(transferIndex);
      transfersByDependency.set(symbol, dependents);
    }),
  );
  const pendingTransfers = resultAliasTransfers.map(
    (_transfer, index) => index,
  );
  const queuedTransfers = new Set(pendingTransfers);
  const aliasWorkBudget = Math.max(64, resultAliasTransfers.length * 8);
  let aliasWork = 0;
  for (let cursor = 0; cursor < pendingTransfers.length; cursor += 1) {
    if (aliasWork >= aliasWorkBudget) break;
    aliasWork += 1;
    const transferIndex = pendingTransfers[cursor]!;
    queuedTransfers.delete(transferIndex);
    resultAliasExpressionCache = new Map();
    const changedSymbols = new Set<SymbolId>();
    changedResultAliasSymbols = changedSymbols;
    resultAliasTransfers[transferIndex]!.apply();
    changedResultAliasSymbols = undefined;
    changedSymbols.forEach((symbol) =>
      (transfersByDependency.get(symbol) ?? []).forEach((dependent) => {
        if (queuedTransfers.has(dependent)) return;
        pendingTransfers.push(dependent);
        queuedTransfers.add(dependent);
      }),
    );
  }
  incrementCompilerPerfCounter(
    "borrowing.ordinaryLocal.resultAliasTransferWork",
    aliasWork,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinaryLocal.resultAliasFallbacks",
    0,
  );
  if (aliasWork >= aliasWorkBudget && pendingTransfers.length > aliasWork) {
    incrementCompilerPerfCounter(
      "borrowing.ordinaryLocal.resultAliasFallbacks",
    );
    const fallbackOrigins = widenResultAliasOrigins(
      index.calls.flatMap(callResultAliasOrigins),
    );
    resultAliasCandidateSymbols.forEach((symbol) =>
      addResultAliasOrigins(symbol, fallbackOrigins),
    );
  }
  resultAliasExpressionCache = new Map();
  const boundResultAliases = Array.from(
    resultAliasOriginsBySymbol,
    ([symbol, origins]) => origins.map((origin) => ({ symbol, ...origin })),
  ).flat();
  const boundResultSymbols = new Set(resultAliasOriginsBySymbol.keys());
  const directAccesses = Array.from(places).flatMap(([expressionId, place]) => {
    if (
      isProjectionTargetExpression({
        expressionId,
        places,
        parentByExpression,
      }) ||
      isDirectCallChild({ expressionId, parentByExpression, hir })
    ) {
      return [];
    }
    const expression = hir.expressions.get(expressionId);
    return expression
      ? [
          {
            expressionId,
            position: positionByExpression.get(expressionId) ?? -1,
            kind: mutablyAssignedPlaceExpressions.has(expressionId)
              ? ("write" as const)
              : ("read" as const),
            place: resolvePlace(place),
            span: expression.span,
          },
        ]
      : [];
  });
  const callAccesses = index.calls.flatMap((call) => {
    const summary = summaryForCall({
      call,
      moduleId,
      localSummaries,
      importedSummaries,
    });
    return call.arguments.flatMap((argument) => {
      const access = localAccessForCallArgument({ call, argument, summary });
      if (access === OrdinaryParameterAccess.Unused) return [];
      const placesForArgument = argument.place
        ? [resolvePlace(argument.place)]
        : [];
      const argumentIsReachableAlias =
        argument.place !== undefined &&
        !index.parameterPlaces.has(argument.place.root) &&
        (argument.callerParameterOrigins?.length ?? 0) > 0;
      const mutableAliasSource =
        argument.place === undefined
          ? undefined
          : aliases.get(argument.place.root);
      const argumentIsMutableReborrow =
        argument.place !== undefined &&
        mutableAliasSource !== undefined &&
        (mutableAliasSource.root !== argument.place.root ||
          mutableAliasSource.projections.length > 0);
      const placeIsBoundResult = placesForArgument.some((place) =>
        boundResultSymbols.has(place.root),
      );
      const retainedReachableAlias =
        argumentIsReachableAlias && !argumentIsMutableReborrow;
      const originPlaces = placeIsBoundResult
        ? []
        : (() => {
            const precise = (argument.callerParameterOriginPlaces ?? []).map(
              ({ parameter, path }) => ({
                parameter,
                path: retainedReachableAlias ? [] : path,
              }),
            );
            const preciseParameters = new Set(
              precise.map(({ parameter }) => parameter),
            );
            const coarse = Array.from(
              new Set([
                ...(argument.callerParameterOrigins ?? []),
                ...(argument.place
                  ? (assignedCallerOrigins.get(argument.place.root) ?? [])
                  : []),
              ]),
            )
              .filter((parameter) => !preciseParameters.has(parameter))
              .map((parameter) => ({ parameter, path: [] }));
            return [...precise, ...coarse].flatMap(({ parameter, path }) => {
              const source = index.parameters[parameter];
              if (!source) return [];
              if (
                typeof argument.type === "number" &&
                typeof source.type === "number" &&
                !typesMayShareReachableIdentity(
                  argument.type,
                  source.type,
                  typing,
                )
              ) {
                return [];
              }
              return [
                {
                  root: source.symbol,
                  projections: path,
                } satisfies BorrowPlace,
              ];
            });
          })();
      return Array.from(
        new Map(
          [...placesForArgument, ...originPlaces].map((place) => [
            placeKey(place),
            place,
          ]),
        ).values(),
      ).map((place) => ({
        expressionId: call.exprId,
        position: positionByExpression.get(call.exprId) ?? -1,
        retainedReachableAlias,
        kind:
          access === OrdinaryParameterAccess.Write
            ? ("write" as const)
            : ("read" as const),
        place,
        span: call.span,
      }));
    });
  });
  const localAccesses = [...directAccesses, ...callAccesses];
  mutableParameters.forEach((mutableParameter) => {
    const mutablePlace: BorrowPlace = {
      root: mutableParameter.symbol,
      projections: [],
    };
    callAccesses
      .filter(
        (access) =>
          access.retainedReachableAlias === true &&
          access.place.root === mutableParameter.symbol &&
          projectionPathsOverlap(
            access.place.projections,
            mutablePlace.projections,
          ),
      )
      .forEach((access) => {
        diagnostics.push(
          conflictDiagnostic({
            span: access.span,
            mutablePlace: displayPlace(mutablePlace, symbolTable),
            existingPlace: displayPlace(access.place, symbolTable),
            existing: access.kind === "write" ? "mutable" : "shared",
          }),
        );
      });
  });
  boundResultAliases.forEach((alias) => {
    const isWithinAliasScope = (expressionId: HirExprId): boolean =>
      typeof alias.scopeRoot !== "number" ||
      expressionId === alias.scopeRoot ||
      isDescendantOf(expressionId, alias.scopeRoot, parentByExpression);
    const aliasAccesses = localAccesses.filter(
      (access) =>
        access.position > alias.formation &&
        isWithinAliasScope(access.expressionId) &&
        access.place.root === alias.symbol &&
        resultAliasPathsOverlap(access.place.projections, alias.targetPath),
    );
    const sourceAccesses = localAccesses.filter(
      (access) =>
        access.position > alias.formation &&
        isWithinAliasScope(access.expressionId) &&
        access.place.root !== alias.symbol &&
        access.place.root === alias.source.root &&
        projectionPathsOverlap(
          access.place.projections,
          alias.source.projections,
        ),
    );
    const firstAliasWrite = earliestAccess(
      aliasAccesses.filter((access) => access.kind === "write"),
    );
    const firstSourceWrite = earliestAccess(
      sourceAccesses.filter((access) => access.kind === "write"),
    );
    const firstAliasAccessAfterSourceWrite = firstSourceWrite
      ? earliestAccess(
          aliasAccesses.filter(
            (access) => access.position >= firstSourceWrite.position,
          ),
        )
      : undefined;
    const firstSourceAccessAfterAliasWrite = firstAliasWrite
      ? earliestAccess(
          sourceAccesses.filter(
            (access) => access.position >= firstAliasWrite.position,
          ),
        )
      : undefined;
    const conflict = [
      ...(firstAliasWrite && firstSourceAccessAfterAliasWrite
        ? [
            {
              aliasAccess: firstAliasWrite,
              sourceAccess: firstSourceAccessAfterAliasWrite,
            },
          ]
        : []),
      ...(firstSourceWrite && firstAliasAccessAfterSourceWrite
        ? [
            {
              aliasAccess: firstAliasAccessAfterSourceWrite,
              sourceAccess: firstSourceWrite,
            },
          ]
        : []),
    ].sort(
      (left, right) =>
        Math.max(left.aliasAccess.position, left.sourceAccess.position) -
        Math.max(right.aliasAccess.position, right.sourceAccess.position),
    )[0];
    if (!conflict) return;
    const aliasIsMutable = conflict.aliasAccess.kind === "write";
    const mutableAccess = aliasIsMutable
      ? conflict.aliasAccess
      : conflict.sourceAccess;
    const existingAccess = aliasIsMutable
      ? conflict.sourceAccess
      : conflict.aliasAccess;
    diagnostics.push(
      conflictDiagnostic({
        span:
          conflict.aliasAccess.position >= conflict.sourceAccess.position
            ? conflict.aliasAccess.span
            : conflict.sourceAccess.span,
        mutablePlace: displayPlace(mutableAccess.place, symbolTable),
        existingPlace: displayPlace(existingAccess.place, symbolTable),
        existing: existingAccess.kind === "write" ? "mutable" : "shared",
      }),
    );
  });

  return deduplicateDiagnostics(diagnostics);
};

const collectAssignedCallerOrigins = ({
  body,
  index,
  hir,
  typing,
  resolveContext,
}: {
  body: HirExprId;
  index: CallableBorrowIndex;
  hir: HirGraph;
  typing: TypingResult;
  resolveContext: ResolveContext;
}): ReadonlyMap<SymbolId, ReadonlySet<number>> => {
  const referenceParameters = index.parameters.filter(
    (parameter) => parameter.referenceCapable === true,
  );
  const originsBySymbol = new Map<SymbolId, Set<number>>(
    referenceParameters.map((parameter) => [
      parameter.symbol,
      new Set([parameter.parameter]),
    ]),
  );
  const sourceRootsOf = (
    expressionId: HirExprId,
    active = new Set<HirExprId>(),
  ): ReadonlySet<SymbolId> => {
    if (active.has(expressionId)) return new Set();
    const type = expressionTypeFor(expressionId, resolveContext);
    if (typeof type === "number" && !typeCanCarryReference(type, typing)) {
      return new Set();
    }
    const place = placeOfExpression(expressionId, hir, resolveContext);
    if (place) return new Set([place.root]);
    const expression = hir.expressions.get(expressionId);
    if (!expression) return new Set();
    const nextActive = new Set(active).add(expressionId);
    const roots = (children: readonly HirExprId[]): ReadonlySet<SymbolId> =>
      new Set(
        children.flatMap((child) =>
          Array.from(sourceRootsOf(child, nextActive)),
        ),
      );
    switch (expression.exprKind) {
      case "tuple":
        return roots(expression.elements);
      case "object-literal":
        return roots(expression.entries.map((entry) => entry.value));
      case "call":
      case "method-call": {
        const callArguments =
          expression.exprKind === "method-call"
            ? [
                expression.target,
                ...expression.args.map((argument) => argument.expr),
              ]
            : expression.args.map((argument) => argument.expr);
        return roots(callArguments);
      }
      case "block":
        return typeof expression.value === "number"
          ? sourceRootsOf(expression.value, nextActive)
          : new Set();
      case "if":
      case "cond":
        return roots([
          ...expression.branches.map((branch) => branch.value),
          ...(typeof expression.defaultBranch === "number"
            ? [expression.defaultBranch]
            : []),
        ]);
      case "match":
        return roots(expression.arms.map((arm) => arm.value));
      case "effect-handler":
        return roots([
          expression.body,
          ...expression.handlers.map((handler) => handler.body),
          ...(typeof expression.finallyBranch === "number"
            ? [expression.finallyBranch]
            : []),
        ]);
      case "assign":
        return sourceRootsOf(expression.value, nextActive);
      case "break":
        return typeof expression.value === "number"
          ? sourceRootsOf(expression.value, nextActive)
          : new Set();
      case "loop": {
        const breakValues: HirExprId[] = [];
        walkExpression({
          exprId: expression.body,
          hir,
          options: { skipLambdas: true },
          onEnterExpression: (_nestedId, nested) => {
            if (
              nested.exprKind === "break" &&
              typeof nested.value === "number"
            ) {
              breakValues.push(nested.value);
            }
          },
        });
        return roots(breakValues);
      }
      case "identifier":
      case "field-access":
      case "literal":
      case "overload-set":
      case "while":
      case "lambda":
      case "continue":
        return new Set();
    }
  };
  const transfers: { target: SymbolId; source: SymbolId }[] = [];
  walkExpression({
    exprId: body,
    hir,
    options: { skipLambdas: true },
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind !== "let") return;
      const sources = sourceRootsOf(statement.initializer);
      patternSymbols(statement.pattern).forEach((target) =>
        sources.forEach((source) => transfers.push({ target, source })),
      );
    },
    onEnterExpression: (_expressionId, expression) => {
      if (expression.exprKind !== "assign") return;
      const sources = sourceRootsOf(expression.value);
      if (sources.size === 0) return;
      if (typeof expression.target === "number") {
        const target = placeOfExpression(
          expression.target,
          hir,
          resolveContext,
        );
        if (target) {
          sources.forEach((source) =>
            transfers.push({ target: target.root, source }),
          );
        }
      }
      if (expression.pattern) {
        patternSymbols(expression.pattern).forEach((target) =>
          sources.forEach((source) => transfers.push({ target, source })),
        );
      }
    },
  });
  const dependents = new Map<SymbolId, number[]>();
  transfers.forEach((transfer, transferIndex) => {
    const current = dependents.get(transfer.source) ?? [];
    current.push(transferIndex);
    dependents.set(transfer.source, current);
  });
  const pending = transfers.map((_transfer, index) => index);
  const queued = new Set(pending);
  const budget = Math.max(64, transfers.length * 8);
  let work = 0;
  for (let cursor = 0; cursor < pending.length && work < budget; cursor += 1) {
    work += 1;
    const transferIndex = pending[cursor]!;
    queued.delete(transferIndex);
    const transfer = transfers[transferIndex]!;
    const sourceOrigins = originsBySymbol.get(transfer.source);
    if (!sourceOrigins || sourceOrigins.size === 0) continue;
    const targetOrigins = originsBySymbol.get(transfer.target) ?? new Set();
    const previousSize = targetOrigins.size;
    sourceOrigins.forEach((origin) => targetOrigins.add(origin));
    if (targetOrigins.size === previousSize) continue;
    originsBySymbol.set(transfer.target, targetOrigins);
    (dependents.get(transfer.target) ?? []).forEach((dependent) => {
      if (queued.has(dependent)) return;
      queued.add(dependent);
      pending.push(dependent);
    });
  }
  incrementCompilerPerfCounter(
    "borrowing.ordinaryLocal.sourceOriginTransfers",
    transfers.length,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinaryLocal.sourceOriginTransferWork",
    work,
  );
  incrementCompilerPerfCounter(
    "borrowing.ordinaryLocal.sourceOriginFallbacks",
    0,
  );
  if (pending.length > work) {
    incrementCompilerPerfCounter(
      "borrowing.ordinaryLocal.sourceOriginFallbacks",
    );
    const allOrigins = new Set(
      referenceParameters.map(({ parameter }) => parameter),
    );
    transfers.forEach(({ target }) => originsBySymbol.set(target, allOrigins));
  }
  return originsBySymbol;
};

const callAccessHasPlannedGuard = ({
  call,
  argument,
  mutableParameter,
  resolvePlace,
  plannedGuards,
}: {
  call: CallableBorrowIndexCall;
  argument: NonNullable<ReturnType<typeof indexCallArgumentFor>>;
  mutableParameter: SymbolId;
  resolvePlace: (place: BorrowPlace) => BorrowPlace;
  plannedGuards: ReadonlyMap<number, readonly RuntimeIdentityGuard[]>;
}): boolean => {
  const parentArguments = call.arguments.filter(
    (candidate) =>
      candidate.place &&
      resolvePlace(candidate.place).root === mutableParameter,
  );
  return parentArguments.some((parent) =>
    (plannedGuards.get(call.exprId) ?? []).some((guard) => {
      const parameters = new Set([guard.left.parameter, guard.right.parameter]);
      return (
        parameters.has(parent.parameter) && parameters.has(argument.parameter)
      );
    }),
  );
};

const callHasUncertainDispatch = (call: CallableBorrowIndexCall): boolean =>
  call.openTraitDispatch === true ||
  call.argumentPlanAmbiguous === true ||
  call.targets.length === 0;

const mutableReferencePatternSymbols = (
  pattern: HirPattern,
  inheritedMutable = false,
): readonly SymbolId[] => {
  const mutable = inheritedMutable || pattern.bindingKind === "mutable-ref";
  switch (pattern.kind) {
    case "identifier":
      return mutable ? [pattern.symbol] : [];
    case "tuple":
      return pattern.elements.flatMap((entry) =>
        mutableReferencePatternSymbols(entry, mutable),
      );
    case "destructure":
      return [
        ...pattern.fields.flatMap((field) =>
          mutableReferencePatternSymbols(field.pattern, mutable),
        ),
        ...(pattern.spread
          ? mutableReferencePatternSymbols(pattern.spread, mutable)
          : []),
      ];
    case "type":
      return pattern.binding
        ? mutableReferencePatternSymbols(pattern.binding, mutable)
        : [];
    case "wildcard":
      return [];
  }
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

const referencedSymbols = (
  expressionId: HirExprId,
  hir: HirGraph,
): ReadonlySet<SymbolId> => {
  const symbols = new Set<SymbolId>();
  walkExpression({
    exprId: expressionId,
    hir,
    options: { skipLambdas: true },
    onEnterExpression: (_childId, expression) => {
      if (expression.exprKind === "identifier") {
        symbols.add(expression.symbol);
      }
    },
  });
  return symbols;
};

const isDirectCallChild = ({
  expressionId,
  parentByExpression,
  hir,
}: {
  expressionId: HirExprId;
  parentByExpression: ReadonlyMap<HirExprId, HirExprId>;
  hir: HirGraph;
}): boolean => {
  const parentId = parentByExpression.get(expressionId);
  const parent =
    typeof parentId === "number" ? hir.expressions.get(parentId) : undefined;
  if (parent?.exprKind === "call") {
    return (
      parent.callee === expressionId ||
      parent.args.some((argument) => argument.expr === expressionId)
    );
  }
  return (
    parent?.exprKind === "method-call" &&
    (parent.target === expressionId ||
      parent.args.some((argument) => argument.expr === expressionId))
  );
};

const placeKey = (place: BorrowPlace): string =>
  `${place.root}:${place.projections
    .map((projection) => JSON.stringify(projection))
    .join("/")}`;

const earliestAccess = <Access extends { position: number }>(
  accesses: readonly Access[],
): Access | undefined =>
  accesses.reduce<Access | undefined>(
    (earliest, access) =>
      !earliest || access.position < earliest.position ? access : earliest,
    undefined,
  );

const localResultAliasOriginsForExpression = ({
  expression,
  originsBySymbol,
  originsOf,
  callsByExpression,
  callOrigins,
  callCanCarryOrigin,
  callArgumentCanCarryOrigin,
  hir,
}: {
  expression: HirExpression;
  originsBySymbol: ReadonlyMap<SymbolId, readonly LocalResultAliasOrigin[]>;
  originsOf: (expression: HirExprId) => readonly LocalResultAliasOrigin[];
  callsByExpression: ReadonlyMap<HirExprId, CallableBorrowIndexCall>;
  callOrigins: (
    call: CallableBorrowIndexCall,
  ) => readonly LocalResultAliasOrigin[];
  callCanCarryOrigin: (call: CallableBorrowIndexCall) => boolean;
  callArgumentCanCarryOrigin: (
    call: CallableBorrowIndexCall,
    argument: CallableBorrowIndexCall["arguments"][number],
  ) => boolean;
  hir: HirGraph;
}): readonly LocalResultAliasOrigin[] => {
  switch (expression.exprKind) {
    case "identifier":
      return originsBySymbol.get(expression.symbol) ?? [];
    case "field-access":
      return selectResultAliasProjection(originsOf(expression.target), {
        kind: "field",
        name: expression.field,
      });
    case "tuple":
      return expression.elements.flatMap((element, index) =>
        prefixResultAliasProjection(originsOf(element), {
          kind: "tuple",
          index,
        }),
      );
    case "object-literal":
      return expression.entries.flatMap((entry) => {
        const origins = originsOf(entry.value);
        return entry.kind === "field"
          ? prefixResultAliasProjection(origins, {
              kind: "field",
              name: entry.name,
            })
          : origins;
      });
    case "call":
    case "method-call": {
      const call = callsByExpression.get(expression.id);
      if (!call) return [];
      const directOrigins = callOrigins(call);
      if (!callCanCarryOrigin(call)) return [];
      return distinctResultAliasOrigins([
        ...directOrigins,
        ...call.arguments.flatMap((argument) =>
          typeof argument.expression === "number" &&
          callArgumentCanCarryOrigin(call, argument)
            ? originsOf(argument.expression)
            : [],
        ),
      ]);
    }
    case "block":
      return typeof expression.value === "number"
        ? originsOf(expression.value)
        : [];
    case "if":
    case "cond":
      return [
        ...expression.branches.flatMap((branch) => originsOf(branch.value)),
        ...(typeof expression.defaultBranch === "number"
          ? originsOf(expression.defaultBranch)
          : []),
      ];
    case "match":
      return expression.arms.flatMap((arm) =>
        originsOf(arm.value).map(
          ({ scopeRoot: _scopeRoot, ...origin }) => origin,
        ),
      );
    case "effect-handler":
      return [
        ...originsOf(expression.body),
        ...expression.handlers.flatMap((handler) => originsOf(handler.body)),
        ...(typeof expression.finallyBranch === "number"
          ? originsOf(expression.finallyBranch)
          : []),
      ];
    case "assign":
      return originsOf(expression.value);
    case "break":
      return typeof expression.value === "number"
        ? originsOf(expression.value)
        : [];
    case "loop": {
      const origins: LocalResultAliasOrigin[] = [];
      walkExpression({
        exprId: expression.body,
        hir,
        options: { skipLambdas: true },
        onEnterExpression: (_expressionId, nested) => {
          if (nested.exprKind === "break" && typeof nested.value === "number") {
            origins.push(...originsOf(nested.value));
          }
        },
      });
      return origins;
    }
    case "literal":
    case "overload-set":
    case "while":
    case "lambda":
    case "continue":
      return [];
  }
};

const prefixResultAliasProjection = (
  origins: readonly LocalResultAliasOrigin[],
  projection: PlaceProjection,
): readonly LocalResultAliasOrigin[] =>
  origins.map((origin) => ({
    ...origin,
    targetPath: [projection, ...origin.targetPath],
  }));

const selectResultAliasProjection = (
  origins: readonly LocalResultAliasOrigin[],
  projection: PlaceProjection,
): readonly LocalResultAliasOrigin[] =>
  origins.flatMap((origin) => {
    if (origin.targetPath.length === 0) return [origin];
    const [head, ...tail] = origin.targetPath;
    return head && projectionPathsOverlap([head], [projection])
      ? [{ ...origin, targetPath: tail }]
      : [];
  });

const resultAliasPathsOverlap = (
  access: readonly PlaceProjection[],
  origin: readonly PlaceProjection[],
): boolean => {
  if (projectionPathsOverlap(access, origin)) return true;
  return projectionPathsOverlap(
    access.filter((projection) => projection.kind !== "dereference"),
    origin.filter((projection) => projection.kind !== "dereference"),
  );
};

const distinctResultAliasOrigins = (
  origins: readonly LocalResultAliasOrigin[],
): readonly LocalResultAliasOrigin[] =>
  Array.from(
    new Map(
      origins.map((origin) => [
        `${placeKey(origin.source)}=>${origin.targetPath
          .map((projection) => JSON.stringify(projection))
          .join("/")}@${origin.formation}#${origin.scopeRoot ?? "callable"}`,
        origin,
      ]),
    ).values(),
  );

const widenResultAliasOrigins = (
  origins: readonly LocalResultAliasOrigin[],
): readonly LocalResultAliasOrigin[] => {
  const widened = new Map<string, LocalResultAliasOrigin>();
  origins.forEach((origin) => {
    const key = `${placeKey(origin.source)}#${origin.scopeRoot ?? "callable"}`;
    const current = widened.get(key);
    if (!current) {
      widened.set(key, origin);
      return;
    }
    widened.set(key, {
      source: current.source,
      targetPath: commonProjectionPrefix(current.targetPath, origin.targetPath),
      formation: Math.min(current.formation, origin.formation),
      scopeRoot: current.scopeRoot,
    });
  });
  return Array.from(widened.values());
};

const commonProjectionPrefix = (
  left: readonly PlaceProjection[],
  right: readonly PlaceProjection[],
): readonly PlaceProjection[] => {
  const length = Math.min(left.length, right.length);
  let shared = 0;
  while (
    shared < length &&
    JSON.stringify(left[shared]) === JSON.stringify(right[shared])
  ) {
    shared += 1;
  }
  return left.slice(0, shared);
};

const resultAliasOriginSetsEqual = (
  left: readonly LocalResultAliasOrigin[],
  right: readonly LocalResultAliasOrigin[],
): boolean => {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(
    right.map(
      (origin) =>
        `${placeKey(origin.source)}=>${origin.targetPath
          .map((projection) => JSON.stringify(projection))
          .join("/")}@${origin.formation}#${origin.scopeRoot ?? "callable"}`,
    ),
  );
  return left.every((origin) =>
    rightKeys.has(
      `${placeKey(origin.source)}=>${origin.targetPath
        .map((projection) => JSON.stringify(projection))
        .join("/")}@${origin.formation}#${origin.scopeRoot ?? "callable"}`,
    ),
  );
};

const localAccessForCallArgument = ({
  call,
  argument,
  summary,
}: {
  call: CallableBorrowIndexCall;
  argument: CallableBorrowIndexCall["arguments"][number];
  summary: OrdinaryMutationSummary | undefined;
}): OrdinaryParameterAccess => {
  if (call.intrinsicName === "__array_set") {
    return argument.parameter === 0
      ? OrdinaryParameterAccess.Write
      : OrdinaryParameterAccess.Read;
  }
  if (
    call.intrinsicName === "__array_get" ||
    call.intrinsicName === "__array_len" ||
    call.intrinsicName === "__ref_is_null"
  ) {
    return argument.parameter === 0
      ? OrdinaryParameterAccess.Read
      : OrdinaryParameterAccess.Unused;
  }
  if (call.compilerArrayIteratorNext === true && argument.parameter === 0) {
    return OrdinaryParameterAccess.Read;
  }
  return (
    (summary
      ? (Math.max(
          summary.directAccesses[argument.parameter] ??
            OrdinaryParameterAccess.Unused,
          summary.reachableAccesses[argument.parameter] ??
            OrdinaryParameterAccess.Unused,
        ) as OrdinaryParameterAccess)
      : undefined) ??
    (callHasUncertainDispatch(call) && argument.referenceCapable === true
      ? OrdinaryParameterAccess.Write
      : OrdinaryParameterAccess.Unused)
  );
};

const summaryForCall = ({
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
  if (call.intrinsic || call.ordinaryMutationFreeConstruction === true) {
    return undefined;
  }
  if (call.ordinaryDynamicBound) {
    return ordinaryMutationDynamicBoundSummary(call.ordinaryDynamicBound);
  }
  if (call.openTraitDispatch && call.signature) {
    return {
      ...ordinaryMutationSignatureUpperBound({ signature: call.signature }),
      ambientAccess: OrdinaryParameterAccess.Write,
      reentrant: true,
      maySuspend: true,
    };
  }
  const summaries = call.targets.flatMap((target) => {
    const summary =
      target.moduleId === moduleId
        ? localSummaries.get(target.symbol)
        : importedSummaries.get(targetKey(target));
    return summary ? [summary] : [];
  });
  const joined = summaries.reduce<OrdinaryMutationSummary | undefined>(
    (current, summary) =>
      current ? joinOrdinaryMutationSummaries(current, summary) : summary,
    undefined,
  );
  if (joined && summaries.length === call.targets.length) {
    return applyExactLocalCallbackHazards({
      call,
      callee: joined,
      localSummaries,
    });
  }
  const bound = call.signature
    ? ordinaryMutationSignatureUpperBound({
        signature: call.signature,
        maySuspend: call.maySuspend,
      })
    : undefined;
  const resolved =
    joined && bound
      ? joinOrdinaryMutationSummaries(joined, bound)
      : (joined ?? bound);
  return resolved
    ? applyExactLocalCallbackHazards({
        call,
        callee: resolved,
        localSummaries,
      })
    : undefined;
};

export const ordinaryAmbientAccessMayOverlap = ({
  index,
  typing,
  moduleId,
  localSummaries,
  importedSummaries,
}: {
  index: CallableBorrowIndex;
  typing: TypingResult;
  moduleId: string;
  localSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  importedSummaries: ReadonlyMap<string, OrdinaryMutationSummary>;
}): boolean => {
  if (!index.flags.hasMutableParameter) return false;
  const summary = localSummaries.get(index.symbol);
  if (!summary || summary.ambientAccess === OrdinaryParameterAccess.Unused) {
    return false;
  }

  const hasPropagatedAmbientAccess = index.calls.some((call) => {
    if (call.scopedSharedCellAccess === true) return false;
    const callSummary = summaryForCall({
      call,
      moduleId,
      localSummaries,
      importedSummaries,
    });
    return (
      callSummary !== undefined &&
      callSummary.ambientAccess !== OrdinaryParameterAccess.Unused
    );
  });
  if (hasPropagatedAmbientAccess) return true;

  const hasDirectAmbientAccess =
    index.flags.hasModuleStorageAccess || index.flags.hasAmbientObjectCapture;
  if (!hasDirectAmbientAccess || index.directAmbientObjectRoots.length === 0) {
    return true;
  }
  return index.directAmbientObjectRoots.some((root) =>
    ambientRootMayOverlap({ root, index, typing }),
  );
};

const ambientRootMayOverlap = ({
  root,
  index,
  typing,
  mutableParameters = index.parameters.filter(
    (parameter) => parameter.bindingKind === "mutable-ref",
  ),
}: {
  root: SymbolId;
  index: CallableBorrowIndex;
  typing: TypingResult;
  mutableParameters?: CallableBorrowIndex["parameters"];
}): boolean => {
  const mutableTypes = mutableParameters.flatMap((parameter) =>
    parameter.bindingKind === "mutable-ref" &&
    typeof parameter.type === "number"
      ? [parameter.type]
      : [],
  );
  if (mutableTypes.length !== mutableParameters.length) {
    return true;
  }
  const ambientType = typing.valueTypes.get(root);
  return (
    typeof ambientType !== "number" ||
    mutableTypes.some((mutableType) =>
      typesMayShareReachableIdentity(ambientType, mutableType, typing),
    )
  );
};

const targetKey = ({ moduleId, symbol }: SymbolRef): string =>
  `${moduleId}::${symbol}`;

const callResultMayCarryReference = (
  call: CallableBorrowIndexCall,
  typing: TypingResult,
): boolean =>
  typeof call.signature?.returnType !== "number" ||
  typeCanCarryReference(call.signature.returnType, typing);

const callResultIsIndependentStableHandle = (
  call: CallableBorrowIndexCall,
  typing: TypingResult,
  symbolTable: SymbolTable,
): boolean => {
  const returnType = call.signature?.returnType;
  if (typeof returnType !== "number") return false;
  const nominal = typing.arena.nominalComponent(returnType);
  if (typeof nominal !== "number") return false;
  const descriptor = typing.arena.get(nominal);
  if (
    descriptor.kind !== "nominal-object" &&
    descriptor.kind !== "value-object"
  ) {
    return false;
  }
  const owner = descriptor.owner.symbol;
  if (!symbolTable.hasSymbol(owner)) return false;
  const metadata = symbolTable.getSymbol(owner).metadata as
    | { intrinsicType?: unknown }
    | undefined;
  return metadata?.intrinsicType === "voyd.std.string-slice";
};

const typesMayShareAllocation = (
  left: TypeId | undefined,
  right: TypeId | undefined,
  typing: TypingResult,
): boolean => {
  if (typeof left !== "number" || typeof right !== "number") return true;
  if (
    !typeIsAllocationBacked(left, typing) ||
    !typeIsAllocationBacked(right, typing)
  ) {
    return false;
  }
  const leftNominal = typing.arena.nominalComponent(left);
  const rightNominal = typing.arena.nominalComponent(right);
  if (leftNominal === undefined || rightNominal === undefined) {
    const leftKind = typing.arena.get(left).kind;
    const rightKind = typing.arena.get(right).kind;
    if (leftKind === "fixed-array" || rightKind === "fixed-array") {
      return leftKind === "fixed-array" && rightKind === "fixed-array";
    }
    return true;
  }
  if (leftNominal === rightNominal) return true;
  return (
    nominalExtends(leftNominal, rightNominal, typing) ||
    nominalExtends(rightNominal, leftNominal, typing)
  );
};

const typesMayShareReachableIdentity = (
  left: TypeId,
  right: TypeId,
  typing: TypingResult,
): boolean => {
  const leftIdentities = reachableIdentityTypes(left, typing);
  const rightIdentities = reachableIdentityTypes(right, typing);
  if (!leftIdentities || !rightIdentities) return true;
  return leftIdentities.some((leftIdentity) =>
    rightIdentities.some((rightIdentity) =>
      typesMayShareAllocation(leftIdentity, rightIdentity, typing),
    ),
  );
};

const reachableIdentityTypes = (
  type: TypeId,
  typing: TypingResult,
  active = new Set<TypeId>(),
  budget = { remaining: 256 },
): readonly TypeId[] | undefined => {
  const normalized = typing.arena.unfoldRecursive(type);
  if (active.has(normalized)) return [];
  budget.remaining -= 1;
  if (budget.remaining < 0) return undefined;
  const nextActive = new Set(active).add(normalized);
  const descriptor = typing.arena.get(normalized);
  switch (descriptor.kind) {
    case "primitive":
      return [];
    case "borrowed":
      return reachableIdentityTypes(
        descriptor.inner,
        typing,
        nextActive,
        budget,
      );
    case "recursive":
      return reachableIdentityTypes(
        descriptor.body,
        typing,
        nextActive,
        budget,
      );
    case "union":
      return collectReachableIdentityTypes(
        descriptor.members,
        typing,
        nextActive,
        budget,
      );
    case "intersection": {
      if (typeof descriptor.nominal !== "number") return undefined;
      const nominal = typing.arena.get(descriptor.nominal);
      const structural =
        typeof descriptor.structural === "number"
          ? typing.arena.get(descriptor.structural)
          : undefined;
      if (
        nominal.kind === "nominal-object" &&
        structural?.kind === "structural-object"
      ) {
        const nested = collectReachableIdentityTypes(
          structural.fields.map((field) => field.type),
          typing,
          nextActive,
          budget,
        );
        return nested ? [descriptor.nominal, ...nested] : undefined;
      }
      return reachableIdentityTypes(
        descriptor.nominal,
        typing,
        nextActive,
        budget,
      );
    }
    case "value-object": {
      const fields = typing.objectsByNominal.get(normalized)?.fields;
      return fields
        ? collectReachableIdentityTypes(
            fields.map((field) => field.type),
            typing,
            nextActive,
            budget,
          )
        : undefined;
    }
    case "nominal-object": {
      const fields = typing.objectsByNominal.get(normalized)?.fields;
      if (!fields) return undefined;
      const nested = collectReachableIdentityTypes(
        fields.map((field) => field.type),
        typing,
        nextActive,
        budget,
      );
      return nested ? [normalized, ...nested] : undefined;
    }
    case "fixed-array": {
      const nested = reachableIdentityTypes(
        descriptor.element,
        typing,
        nextActive,
        budget,
      );
      return nested ? [normalized, ...nested] : undefined;
    }
    case "structural-object":
    case "trait":
    case "function":
    case "type-param-ref":
      return undefined;
  }
};

const collectReachableIdentityTypes = (
  types: readonly TypeId[],
  typing: TypingResult,
  active: ReadonlySet<TypeId>,
  budget: { remaining: number },
): readonly TypeId[] | undefined => {
  const collected = types.map((type) =>
    reachableIdentityTypes(type, typing, new Set(active), budget),
  );
  if (collected.some((identities) => identities === undefined)) {
    return undefined;
  }
  return Array.from(new Set(collected.flatMap((identities) => identities!)));
};

const nominalExtends = (
  actual: TypeId,
  expected: TypeId,
  typing: TypingResult,
): boolean => {
  const seen = new Set<TypeId>();
  let current: TypeId | undefined = actual;
  while (typeof current === "number" && !seen.has(current)) {
    if (current === expected) return true;
    seen.add(current);
    current = typing.objectsByNominal.get(current)?.baseNominal;
  }
  return false;
};

const isDescendantOf = (
  expression: HirExprId,
  ancestor: HirExprId,
  parents: ReadonlyMap<HirExprId, HirExprId>,
): boolean => {
  const seen = new Set<HirExprId>();
  let current = parents.get(expression);
  while (typeof current === "number" && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
};

const isProjectionTargetExpression = ({
  expressionId,
  places,
  parentByExpression,
}: {
  expressionId: HirExprId;
  places: ReadonlyMap<HirExprId, BorrowPlace>;
  parentByExpression: ReadonlyMap<HirExprId, HirExprId>;
}): boolean => {
  const place = places.get(expressionId);
  const parent = parentByExpression.get(expressionId);
  const parentPlace =
    typeof parent === "number" ? places.get(parent) : undefined;
  return (
    place !== undefined &&
    parentPlace !== undefined &&
    parentPlace.root === place.root &&
    parentPlace.projections.length > place.projections.length
  );
};

const symbolName = (symbol: SymbolId, symbolTable: SymbolTable): string =>
  symbolTable.hasSymbol(symbol)
    ? symbolTable.getSymbol(symbol).name
    : `value ${symbol}`;

const displayPlace = (place: BorrowPlace, symbolTable: SymbolTable): string => {
  const suffix = place.projections.map(displayProjection).join("");
  return `${symbolName(place.root, symbolTable)}${suffix}`;
};

const displayProjection = (projection: PlaceProjection): string => {
  switch (projection.kind) {
    case "field":
      return `.${projection.name}`;
    case "tuple":
      return `[${projection.index}]`;
    case "index":
      return projection.constant === undefined
        ? "[dynamic index]"
        : `[${projection.constant}]`;
    case "dereference":
      return ".<allocation>";
    case "identity":
    case "discriminant":
      return "";
  }
};

const conflictDiagnostic = ({
  span,
  mutablePlace,
  existingPlace,
  existing = "mutable",
}: {
  span: SourceSpan;
  mutablePlace: string;
  existingPlace: string;
  existing?: "shared" | "mutable";
}): Diagnostic =>
  diagnosticFromCode({
    code: "TY0048",
    params: {
      kind: "borrow-conflict",
      access: "mutably borrow",
      place: mutablePlace,
      existing,
    },
    span,
    related: [
      diagnosticFromCode({
        code: "TY0048",
        params: {
          kind: "borrow-origin",
          place: existingPlace,
          borrow: existing,
        },
        span,
        severity: "note",
      }),
    ],
  });

const deduplicateDiagnostics = (
  diagnostics: readonly Diagnostic[],
): readonly Diagnostic[] =>
  Array.from(
    new Map(
      diagnostics.map((diagnostic) => [
        `${diagnostic.code}:${diagnostic.span.file}:${diagnostic.span.start}:${diagnostic.message}`,
        diagnostic,
      ]),
    ).values(),
  );
