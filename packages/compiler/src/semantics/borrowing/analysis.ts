import type { SymbolTable } from "../binder/index.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import {
  incrementCompilerPerfCounter,
  markCompilerPerfPhaseDuration,
  startCompilerPerfPhase,
} from "../../perf.js";
import {
  type HirFunction,
  type HirGraph,
  type HirLambdaExpr,
  type HirModuleLet,
} from "../hir/index.js";
import type { HirExprId, HirItemId, SymbolId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { DeclTable } from "../decls.js";
import {
  analyzeFunctionBorrowing,
  analyzeLambdaBodyBorrowing,
} from "./body-analysis.js";
import type {
  BorrowingResult,
  CallableBorrowContract,
  PlaceProjection,
} from "./model.js";
import {
  mergeCallableBorrowContracts,
  translateProjectionPath,
} from "./model.js";
import type { BorrowingDependency } from "./dependency.js";
import { computeCallableBorrowContracts } from "./summaries.js";
import {
  abstractTraitContractFromImplementation,
  projectedTypes,
  resolveBorrowCall,
  type ResolveContext,
} from "./call-resolution.js";
import {
  referenceOriginsInType,
  typeCanCarryReference,
} from "./reference-bearing.js";
import { borrowedPathsInType, typeContainsBorrowed } from "./borrowed-types.js";
import { objectLiteralFieldProvider } from "./object-literal-providers.js";
import { validateNamedBorrowContracts } from "./named-contracts.js";
import {
  extractCallableBorrowFacts,
  extractLambdaBorrowFacts,
  type CallableBorrowCallFact,
  type CallableBorrowFacts,
} from "./callable-facts.js";

export const analyzeBorrowing = ({
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  checkBodies = true,
}: {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: readonly {
    local: SymbolId;
    target?: SymbolRef;
  }[];
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
  checkBodies?: boolean;
}): BorrowingResult => {
  const summariesStartedAt = startCompilerPerfPhase();
  const summaryHir = hirWithTraitDefaultFunctions(hir);
  const effectOperationContracts = effectOperationCallableContracts({
    hir,
    typing,
    decls,
  });
  // Lower declared trait/region contracts before body inference. Declaration
  // validation does not need inferred body facts; seeding the single contract
  // solve here avoids analyzing every callable once to discover declarations
  // and then again with those declarations installed.
  const preliminaryNamedContracts = validateNamedBorrowContracts({
    hir,
    typing,
    symbolTable,
    callables: new Map(),
    moduleId,
    imports,
    validateBodies: false,
  });
  const importMap = new Map(
    imports.flatMap((entry) =>
      entry.target ? ([[entry.local, entry.target]] as const) : [],
    ),
  );
  const declaredContracts = new Map([
    ...effectOperationContracts,
    ...preliminaryNamedContracts.declarationCallables,
  ]);
  const functions = Array.from(summaryHir.items.values()).filter(
    (item): item is HirFunction => item.kind === "function",
  );
  const lambdas = Array.from(hir.expressions.values()).filter(
    (expr): expr is HirLambdaExpr => expr.exprKind === "lambda",
  );
  const factsStartedAt = startCompilerPerfPhase();
  const callableFacts = extractCallableBorrowFacts({
    functions,
    hir: summaryHir,
    typing,
    resolveContext: {
      hir: summaryHir,
      typing,
      symbolTable,
      moduleId,
      imports: importMap,
      dependencies,
      contracts: declaredContracts,
      bindingInitializers: new Map(),
      callResolutionCache: new Map(),
      borrowIndexMode: "symbolic",
      decls,
    },
  });
  const lambdaFacts = extractLambdaBorrowFacts({
    lambdas,
    hir: summaryHir,
    typing,
    resolveContext: {
      hir: summaryHir,
      typing,
      symbolTable,
      moduleId,
      imports: importMap,
      dependencies,
      contracts: declaredContracts,
      bindingInitializers: new Map(),
      callResolutionCache: new Map(),
      borrowIndexMode: "symbolic",
      decls,
    },
  });
  const allCallableFacts = new Map<SymbolId, CallableBorrowFacts>([
    ...callableFacts,
    ...Array.from(
      lambdaFacts.values(),
      (facts) => [facts.symbol, facts] as const,
    ),
  ]);
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.extractFacts",
    factsStartedAt,
  );
  incrementCompilerPerfCounter(
    "borrowing.facts.blocks",
    Array.from(allCallableFacts.values()).reduce(
      (total, facts) => total + facts.blocks.length,
      0,
    ),
  );
  incrementCompilerPerfCounter(
    "borrowing.facts.operations",
    Array.from(allCallableFacts.values()).reduce(
      (total, facts) => total + facts.operations.length,
      0,
    ),
  );
  incrementCompilerPerfCounter(
    "borrowing.facts.suspensions",
    Array.from(allCallableFacts.values()).reduce(
      (total, facts) => total + facts.suspensionPoints.length,
      0,
    ),
  );
  const inferStartedAt = startCompilerPerfPhase();
  const inferred = computeCallableBorrowContracts({
    hir: summaryHir,
    typing,
    symbolTable,
    moduleId,
    imports,
    dependencies,
    decls,
    declarationContracts: declaredContracts,
    facts: callableFacts,
    lambdaFacts,
  });
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.inferContracts",
    inferStartedAt,
  );
  const publicDynamicContract = ({
    contract,
    named,
    declarations,
  }: {
    contract: CallableBorrowContract;
    named: import("./model.js").CheckedNamedBorrowContract;
    declarations: ReadonlyMap<SymbolId, CallableBorrowContract>;
  }): CallableBorrowContract => {
    const implementation = abstractTraitContractFromImplementation({
      contract,
      named,
      privateFieldNames: new Set(),
    });
    const declaration = declarations.get(named.declaration);
    return declaration
      ? mergeCallableBorrowContracts([implementation, declaration])!
      : implementation;
  };
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.computeContracts",
    summariesStartedAt,
  );
  const mutableStorageSymbols = new Set<SymbolId>();
  const runtimeIdentityGuards = new Map<
    number,
    import("./model.js").RuntimeIdentityGuard[]
  >();
  const diagnostics: BorrowingResult["diagnostics"][number][] = [];
  const validationStartedAt = startCompilerPerfPhase();
  const namedContracts = validateNamedBorrowContracts({
    hir,
    typing,
    symbolTable,
    callables: inferred.contracts,
    moduleId,
    imports,
    validateBodies: checkBodies,
  });
  diagnostics.push(...namedContracts.diagnostics);
  const callables = new Map(inferred.contracts);
  namedContracts.declarationCallables.forEach((contract, symbol) => {
    callables.set(symbol, contract);
  });
  namedContracts.contracts.forEach((named, symbol) => {
    const contract = callables.get(symbol);
    if (named.implementation === undefined || !contract) {
      return;
    }
    callables.set(symbol, {
      ...contract,
      dynamicDispatch: publicDynamicContract({
        contract,
        named,
        declarations: namedContracts.declarationCallables,
      }),
    });
  });
  effectOperationContracts.forEach((contract, symbol) => {
    callables.set(symbol, contract);
  });
  const resolvedContracts = new Map(callables);
  inferred.lambdaContracts.forEach((contract, exprId) => {
    const facts = lambdaFacts.get(exprId);
    if (facts) resolvedContracts.set(facts.symbol, contract);
  });
  const resolveContext: ResolveContext = {
    hir,
    typing,
    symbolTable,
    moduleId,
    imports: importMap,
    dependencies,
    contracts: resolvedContracts,
    bindingInitializers: new Map(),
    callResolutionCache: new Map(),
    decls,
  };
  validateModuleBorrowStorage({
    hir,
    typing,
    symbolTable,
    resolveContext,
    diagnostics,
  });
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.validateContracts",
    validationStartedAt,
  );
  if (checkBodies) {
    const selectionStartedAt = startCompilerPerfPhase();
    const bodyDecisions = functions.map((functionItem) => ({
      functionItem,
      decision: bodyBorrowAnalysisDemand({
        body: functionItem,
        facts: callableFacts.get(functionItem.symbol),
        typing,
        resolveContext,
      }),
    }));
    const lambdaDecisions = lambdas.map((lambda) => ({
      lambda,
      decision: lambdaBorrowAnalysisDemand({
        lambda,
        facts: lambdaFacts.get(lambda.id)!,
        typing,
        resolveContext,
      }),
    }));
    const checkedFunctions = bodyDecisions
      .filter(({ decision }) => decision.required)
      .map(({ functionItem }) => functionItem);
    [...bodyDecisions, ...lambdaDecisions].forEach(({ decision }) =>
      decision.reasons.forEach((reason) =>
        incrementCompilerPerfCounter(`borrowing.body.demandReason.${reason}`),
      ),
    );
    incrementCompilerPerfCounter(
      "borrowing.body.totalCallables",
      functions.length + lambdas.length,
    );
    incrementCompilerPerfCounter(
      "borrowing.body.checkedCallables",
      checkedFunctions.length +
        lambdaDecisions.filter(({ decision }) => decision.required).length,
    );
    const moduleStorageSymbols = new Set(
      Array.from(summaryHir.items.values())
        .filter((item) => item.kind === "module-let")
        .map((item) => item.symbol),
    );
    markCompilerPerfPhaseDuration(
      "analyzeBorrowing.selectBodies",
      selectionStartedAt,
    );
    const bodiesStartedAt = startCompilerPerfPhase();
    checkedFunctions.forEach((functionItem) =>
      analyzeFunctionBorrowing({
        functionItem,
        facts: callableFacts.get(functionItem.symbol)!,
        lambdaFacts,
        hir: summaryHir,
        typing,
        symbolTable,
        moduleId,
        imports: importMap,
        dependencies,
        decls,
        contracts: resolvedContracts,
        moduleStorageSymbols,
        mutableStorageSymbols,
        runtimeIdentityGuards,
        diagnostics,
      }),
    );
    lambdaDecisions
      .filter(({ decision }) => decision.required)
      .forEach(({ lambda }) =>
        analyzeLambdaBodyBorrowing({
          lambda,
          facts: lambdaFacts.get(lambda.id)!,
          lambdaFacts,
          hir,
          typing,
          symbolTable,
          moduleId,
          imports: importMap,
          dependencies,
          decls,
          contracts: resolvedContracts,
          moduleStorageSymbols,
          mutableStorageSymbols,
          runtimeIdentityGuards,
          diagnostics,
        }),
      );
    markCompilerPerfPhaseDuration(
      "analyzeBorrowing.checkLoans",
      bodiesStartedAt,
    );
  }
  const queryDependencies = new Map(
    Array.from(inferred.queries, ([symbol, query]) => [
      symbol,
      new Map(
        query.dependencies.map((dependency) => [
          `${dependency.moduleId}:${dependency.symbol}`,
          dependency,
        ]),
      ),
    ]),
  );
  namedContracts.contracts.forEach((named, symbol) => {
    const dependenciesForCallable =
      queryDependencies.get(symbol) ?? new Map<string, SymbolRef>();
    const declaration = { moduleId, symbol: named.declaration };
    dependenciesForCallable.set(
      `${declaration.moduleId}:${declaration.symbol}`,
      declaration,
    );
    queryDependencies.set(symbol, dependenciesForCallable);
  });
  const queries = new Map(inferred.queries);
  callables.forEach((output, symbol) => {
    const prior = inferred.queries.get(symbol);
    queries.set(symbol, {
      input:
        prior?.input ??
        `${moduleId}:${symbol}:declared:${JSON.stringify(output)}`,
      dependencies: Array.from(queryDependencies.get(symbol)?.values() ?? []),
      output,
    });
  });
  return {
    callables,
    namedContracts: namedContracts.contracts,
    runtimeIdentityGuards,
    mutableStorageSymbols,
    diagnostics,
    queries,
  };
};

const effectOperationCallableContracts = ({
  hir,
  typing,
  decls,
}: {
  hir: HirGraph;
  typing: TypingResult;
  decls: DeclTable;
}): ReadonlyMap<SymbolId, CallableBorrowContract> =>
  new Map(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "effect"
        ? item.operations.flatMap((operation) => {
            const signature = typing.functions.getSignature(operation.symbol);
            if (!signature) {
              return [];
            }
            const resultContainsBorrow = typeContainsBorrowed(
              signature.returnType,
              typing,
            );
            const resultCarriesReference = typeCanCarryReference(
              signature.returnType,
              typing,
            );
            const resultReferencePaths = resultCarriesReference
              ? referenceOriginsInType(signature.returnType, typing).map(
                  (origin) => origin.path,
                )
              : [];
            const maySuspend =
              decls.getEffectOperation(operation.symbol)?.operation
                .resumable === "resume";
            const operationContract = {
              parameters: signature.parameters.map((parameter) => {
                const reference = typeCanCarryReference(parameter.type, typing);
                const access =
                  parameter.bindingKind === "mutable-ref"
                    ? ("mutable" as const)
                    : reference
                      ? ("shared" as const)
                      : ("owned" as const);
                return {
                  access,
                  ...(access === "shared" ? { readPaths: [[]] } : {}),
                  ...(access === "mutable" ? { writePaths: [[]] } : {}),
                  retained: reference,
                  returned: reference && resultCarriesReference,
                  ...(reference && resultCarriesReference
                    ? {
                        returnedOrigins: referenceOriginsInType(
                          parameter.type,
                          typing,
                        ).flatMap((source) =>
                          resultReferencePaths.map((result) => ({
                            source: source.path,
                            result,
                            endpointAccess: source.endpointAccess,
                          })),
                        ),
                      }
                    : {}),
                  ...(reference ? { externalRetainedPaths: [[]] } : {}),
                };
              }),
              maySuspend,
              borrowedResult: resultContainsBorrow
                ? ("external" as const)
                : ("none" as const),
              ...(resultReferencePaths.length > 0
                ? {
                    externalReturnedOrigins: referenceOriginsInType(
                      signature.returnType,
                      typing,
                    ).map((result) => ({
                      result: result.path,
                      endpointAccess: result.endpointAccess,
                    })),
                  }
                : {}),
            };
            return [[operation.symbol, operationContract] as const];
          })
        : [],
    ),
  );

const hirWithTraitDefaultFunctions = (hir: HirGraph): HirGraph => {
  const existingSymbols = new Set(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "function" ? [item.symbol] : [],
    ),
  );
  const defaultMethods = Array.from(hir.items.values()).flatMap((item) =>
    item.kind === "trait"
      ? item.methods.flatMap((method) =>
          typeof method.defaultBody === "number" &&
          !existingSymbols.has(method.symbol)
            ? [{ trait: item, method }]
            : [],
        )
      : [],
  );
  if (defaultMethods.length === 0) {
    return hir;
  }

  const items = new Map(hir.items);
  defaultMethods.forEach(({ trait, method }, index) => {
    const id = (-1 - index) as HirItemId;
    items.set(id, {
      kind: "function",
      id,
      ast: method.returnType?.ast ?? trait.ast,
      span: method.span,
      visibility: trait.visibility,
      symbol: method.symbol,
      typeParameters: method.typeParameters,
      parameters: method.parameters.map((parameter) => ({
        symbol: parameter.symbol,
        pattern: {
          kind: "identifier",
          symbol: parameter.symbol,
          bindingKind: parameter.bindingKind,
          span: parameter.span,
        },
        span: parameter.span,
        label: parameter.label,
        mutable: parameter.mutable,
        type: parameter.type,
      })),
      returnType: method.returnType,
      effectType: method.effectType,
      body: method.defaultBody!,
      borrowContract: method.borrowContract,
    });
  });
  return { ...hir, items };
};

type BorrowedResultPresence = "none" | "parameter" | "external";

const combineBorrowedResultPresence = (
  values: readonly BorrowedResultPresence[],
): BorrowedResultPresence =>
  values.includes("external")
    ? "external"
    : values.includes("parameter")
      ? "parameter"
      : "none";

/**
 * Module storage only needs the caller-visible presence encoded by compact
 * contracts. Function bodies were already analyzed by the shared fact/flow
 * solve; do not recursively reinterpret their HIR here.
 */
const moduleInitializerBorrowedPresence = ({
  exprId,
  path = [],
  hir,
  typing,
  resolveContext,
  seen = new Set(),
  borrowedContext = false,
}: {
  exprId: HirExprId;
  path?: readonly PlaceProjection[];
  hir: HirGraph;
  typing: TypingResult;
  resolveContext: ResolveContext;
  seen?: ReadonlySet<HirExprId>;
  borrowedContext?: boolean;
}): BorrowedResultPresence => {
  if (seen.has(exprId)) {
    return "external";
  }
  const expression = hir.expressions.get(exprId);
  if (!expression) {
    return "external";
  }
  const type = typing.resolvedExprTypes.get(exprId);
  if (
    !borrowedContext &&
    typeof type === "number" &&
    projectedTypes(type, path, typing).every(
      (candidate) =>
        !typeContainsBorrowed(candidate, typing) &&
        !typing.arena.containsTypeParams(candidate),
    )
  ) {
    return "none";
  }
  const nextSeen = new Set(seen).add(exprId);
  const presence = (
    child: HirExprId,
    childPath: readonly PlaceProjection[] = [],
    childBorrowedContext = borrowedContext,
  ): BorrowedResultPresence =>
    moduleInitializerBorrowedPresence({
      exprId: child,
      path: childPath,
      hir,
      typing,
      resolveContext,
      seen: nextSeen,
      borrowedContext: childBorrowedContext,
    });
  if (path.length > 0) {
    const [projection, ...remaining] = path;
    if (expression.exprKind === "tuple" && projection?.kind === "tuple") {
      const element = expression.elements[projection.index];
      return typeof element === "number"
        ? presence(element, remaining)
        : "external";
    }
    if (
      expression.exprKind === "object-literal" &&
      projection?.kind === "field"
    ) {
      const provider = objectLiteralFieldProvider({
        expression,
        field: projection.name,
        spreadProvidesField: (value) => {
          const spreadType = typing.resolvedExprTypes.get(value);
          return (
            typeof spreadType === "number" &&
            projectedTypes(spreadType, [projection], typing).length > 0
          );
        },
      });
      return provider
        ? presence(
            provider.value,
            provider.kind === "spread" ? path : remaining,
          )
        : "none";
    }
    if (expression.exprKind === "field-access") {
      const selected = Number.isInteger(Number(expression.field))
        ? ({ kind: "tuple", index: Number(expression.field) } as const)
        : ({ kind: "field", name: expression.field } as const);
      return presence(expression.target, [selected, ...path]);
    }
  }
  switch (expression.exprKind) {
    case "literal":
    case "lambda":
      return borrowedContext ? "external" : "none";
    case "overload-set":
    case "continue":
      return "none";
    case "identifier":
      return "external";
    case "tuple": {
      const borrowedPaths =
        typeof type === "number" ? borrowedPathsInType(type, typing) : [];
      return combineBorrowedResultPresence(
        borrowedPaths.length > 0
          ? borrowedPaths.map((borrowedPath) =>
              moduleInitializerBorrowedPresence({
                exprId,
                path: borrowedPath,
                hir,
                typing,
                resolveContext,
                seen,
                borrowedContext: true,
              }),
            )
          : expression.elements.map((element) => presence(element)),
      );
    }
    case "object-literal": {
      if (expression.entries.length === 0) {
        return "none";
      }
      const borrowedPaths =
        typeof type === "number" ? borrowedPathsInType(type, typing) : [];
      return combineBorrowedResultPresence(
        borrowedPaths.length > 0
          ? borrowedPaths.map((borrowedPath) =>
              moduleInitializerBorrowedPresence({
                exprId,
                path: borrowedPath,
                hir,
                typing,
                resolveContext,
                seen,
                borrowedContext: true,
              }),
            )
          : expression.entries.map((entry) => presence(entry.value)),
      );
    }
    case "field-access": {
      const selected = Number.isInteger(Number(expression.field))
        ? ({ kind: "tuple", index: Number(expression.field) } as const)
        : ({ kind: "field", name: expression.field } as const);
      return presence(expression.target, [selected, ...path]);
    }
    case "block":
      return typeof expression.value === "number"
        ? presence(expression.value, path)
        : "none";
    case "if":
    case "cond":
      return combineBorrowedResultPresence([
        ...expression.branches.map((branch) => presence(branch.value, path)),
        ...(typeof expression.defaultBranch === "number"
          ? [presence(expression.defaultBranch, path)]
          : []),
      ]);
    case "match":
      return combineBorrowedResultPresence(
        expression.arms.map((arm) => presence(arm.value, path)),
      );
    case "effect-handler":
      return combineBorrowedResultPresence([
        presence(expression.body, path),
        ...expression.handlers.map((handler) => presence(handler.body, path)),
      ]);
    case "call":
    case "method-call": {
      const resolved = resolveBorrowCall(expression, resolveContext);
      const contract = resolved.contract;
      const resultPresence = contract?.borrowedResult ?? "external";
      if (resultPresence === "none") {
        const returnType = resolved.signature?.returnType;
        return !borrowedContext ||
          (typeof returnType === "number" &&
            (typeContainsBorrowed(returnType, typing) ||
              typing.arena.containsTypeParams(returnType)))
          ? "none"
          : "external";
      }
      if (resultPresence !== "parameter") {
        return resultPresence;
      }
      const inputs =
        contract?.parameters.flatMap((parameter, index) =>
          (parameter.returnedOrigins ?? []).flatMap((origin) => {
            const source = translateProjectionPath({
              result: origin.result,
              source: origin.source,
              requested: path,
            });
            return source ? [{ parameter: index, source }] : [];
          }),
        ) ?? [];
      if (inputs.length === 0) {
        return "external";
      }
      const argumentPresence = (
        parameter: number,
        source: readonly PlaceProjection[],
        active: ReadonlySet<number> = new Set(),
      ): BorrowedResultPresence => {
        if (active.has(parameter)) {
          return "external";
        }
        const argument = resolved.arguments[parameter];
        if (typeof argument === "number") {
          return presence(argument, source, true);
        }
        const parameterContract = contract?.parameters[parameter];
        if (
          parameterContract?.defaultBorrowedResult === "none" ||
          parameterContract?.defaultNoBorrowPaths?.some(
            (noBorrow) =>
              translateProjectionPath({
                result: noBorrow,
                source: [],
                requested: source,
              }) !== undefined,
          )
        ) {
          return "none";
        }
        const defaultInputs =
          parameterContract?.defaultOrigins?.flatMap((origin) => {
            const translated = translateProjectionPath({
              result: origin.result,
              source: origin.source,
              requested: source,
            });
            return translated
              ? [{ parameter: origin.parameter, source: translated }]
              : [];
          }) ?? [];
        return defaultInputs.length > 0
          ? combineBorrowedResultPresence(
              defaultInputs.map((input) =>
                argumentPresence(
                  input.parameter,
                  input.source,
                  new Set(active).add(parameter),
                ),
              ),
            )
          : "external";
      };
      return combineBorrowedResultPresence(
        inputs.map(({ parameter, source }) =>
          argumentPresence(parameter, source),
        ),
      );
    }
    case "assign":
      return presence(expression.value, path);
    case "break":
      return typeof expression.value === "number"
        ? presence(expression.value, path)
        : "none";
    case "loop":
    case "while":
      return "none";
  }
};
const validateModuleBorrowStorage = ({
  hir,
  typing,
  symbolTable,
  resolveContext,
  diagnostics,
}: {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  resolveContext: ResolveContext;
  diagnostics: BorrowingResult["diagnostics"][number][];
}): void => {
  Array.from(hir.items.values())
    .filter((item): item is HirModuleLet => item.kind === "module-let")
    .forEach((item) => {
      const storedType = typing.valueTypes.get(item.symbol);
      const initializerType = typing.resolvedExprTypes.get(item.initializer);
      const type = storedType ?? initializerType;
      const storedDescriptor =
        typeof storedType === "number"
          ? typing.arena.get(typing.arena.unfoldRecursive(storedType))
          : undefined;
      if (
        typeof type !== "number" ||
        !typeContainsBorrowed(type, typing) ||
        (storedDescriptor?.kind !== "borrowed" &&
          moduleInitializerBorrowedPresence({
            exprId: item.initializer,
            hir,
            typing,
            resolveContext,
          }) === "none")
      ) {
        return;
      }
      diagnostics.push(
        diagnosticFromCode({
          code: "TY0051",
          params: {
            kind: "explicit-borrow-escape",
            binding: symbolTable.getSymbol(item.symbol).name,
            through: "module storage",
          },
          span: item.span,
        }),
      );
    });
};

// A body without both reference state and a borrow-producing or mutating
// operation cannot form an alias conflict. Unknown types and calls remain on
// the full-analysis path.
const bodyBorrowAnalysisDemand = ({
  body,
  facts,
  typing,
  resolveContext,
}: {
  body: HirFunction;
  facts: CallableBorrowFacts | undefined;
  typing: TypingResult;
  resolveContext: ResolveContext;
}): { required: boolean; reasons: readonly string[] } => {
  if (!facts) {
    return { required: true, reasons: ["missing-facts"] };
  }
  const reasons = new Set<string>();
  const signature = typing.functions.getSignature(body.symbol);
  const hasSignatureBorrow =
    body.parameters.some(
      (parameter) => parameter.pattern.bindingKind === "mutable-ref",
    ) ||
    (signature?.parameters.some((parameter) =>
      typeContainsBorrowed(parameter.type, typing),
    ) ??
      false) ||
    (typeof signature?.returnType === "number" &&
      typeContainsBorrowed(signature.returnType, typing));
  if (facts.hasMutableCapture) {
    return { required: true, reasons: ["mutable-capture"] };
  }
  if (facts.hasUnknownExpressionType) {
    return { required: true, reasons: ["unknown-expression-type"] };
  }
  if (hasSignatureBorrow) reasons.add("signature-borrow");
  if (facts.hasReferenceAssignment) reasons.add("reference-assignment");
  if (facts.hasBorrowTypedExpression) reasons.add("borrowed-expression");
  // Explicit reference bindings require alias/storage planning even when the
  // referenced value is scalar. For example, `let ~alias = value` must promote
  // a mutable scalar source to codegen storage. Filtering this admission on
  // reference-bearing types skips that planning and leaves codegen with an
  // alias whose source has no storage slot.
  const hasLiveMutableBinding = Array.from(facts.mutableSymbols).some((symbol) =>
    facts.liveness.has(symbol),
  );
  if (hasLiveMutableBinding) reasons.add("mutable-binding");
  let hasBorrowOperation =
    hasSignatureBorrow ||
    facts.hasReferenceAssignment ||
    facts.hasBorrowTypedExpression ||
    hasLiveMutableBinding;
  let hasReferenceState =
    hasSignatureBorrow || facts.hasReferenceState || hasLiveMutableBinding;
  facts.calls.forEach((call) => {
    const demand = borrowDemandForCallFact(
      call,
      resolveContext,
      callResultIsConsumed(call.exprId, facts),
      facts,
    );
    hasBorrowOperation ||= demand.requiresAnalysis;
    hasReferenceState ||= demand.referenceState;
    if (demand.requiresAnalysis) {
      reasons.add("callee-contract");
      demand.reasons.forEach((reason) => reasons.add(`callee-${reason}`));
    }
  });
  const required = hasBorrowOperation && hasReferenceState;
  if (!required) {
    reasons.add(
      hasBorrowOperation ? "no-reference-state" : "no-borrow-operation",
    );
  }
  return { required, reasons: Array.from(reasons) };
};

const lambdaBorrowAnalysisDemand = ({
  lambda,
  facts,
  typing,
  resolveContext,
}: {
  lambda: HirLambdaExpr;
  facts: CallableBorrowFacts | undefined;
  typing: TypingResult;
  resolveContext: ResolveContext;
}): { required: boolean; reasons: readonly string[] } => {
  if (!facts) {
    return { required: true, reasons: ["missing-facts"] };
  }
  if (facts.hasMutableCapture) {
    return { required: true, reasons: ["mutable-capture"] };
  }
  if (facts.hasUnknownExpressionType) {
    return { required: true, reasons: ["unknown-expression-type"] };
  }
  const lambdaType = typing.resolvedExprTypes.get(lambda.id);
  const signature =
    typeof lambdaType === "number" ? typing.arena.get(lambdaType) : undefined;
  const hasSignatureBorrow =
    signature?.kind === "function" &&
    (signature.parameters.some((parameter) =>
      typeContainsBorrowed(parameter.type, typing),
    ) ||
      typeContainsBorrowed(signature.returnType, typing));
  const reasons = new Set<string>();
  if (hasSignatureBorrow) reasons.add("signature-borrow");
  if (facts.hasReferenceAssignment) reasons.add("reference-assignment");
  if (facts.hasBorrowTypedExpression) reasons.add("borrowed-expression");
  const hasLiveMutableBinding = Array.from(facts.mutableSymbols).some((symbol) =>
    facts.liveness.has(symbol),
  );
  if (hasLiveMutableBinding) reasons.add("mutable-binding");
  let hasBorrowOperation =
    hasSignatureBorrow ||
    facts.hasReferenceAssignment ||
    facts.hasBorrowTypedExpression ||
    hasLiveMutableBinding;
  let hasReferenceState =
    hasSignatureBorrow || facts.hasReferenceState || hasLiveMutableBinding;
  facts.calls.forEach((call) => {
    const demand = borrowDemandForCallFact(
      call,
      resolveContext,
      callResultIsConsumed(call.exprId, facts),
      facts,
    );
    hasBorrowOperation ||= demand.requiresAnalysis;
    hasReferenceState ||= demand.referenceState;
    if (demand.requiresAnalysis) {
      reasons.add("callee-contract");
      demand.reasons.forEach((reason) => reasons.add(`callee-${reason}`));
    }
  });
  const required = hasBorrowOperation && hasReferenceState;
  if (!required) {
    reasons.add(
      hasBorrowOperation ? "no-reference-state" : "no-borrow-operation",
    );
  }
  return { required, reasons: Array.from(reasons) };
};

const borrowDemandForCallFact = (
  call: CallableBorrowCallFact,
  resolveContext: ResolveContext,
  resultIsConsumed: boolean,
  facts: CallableBorrowFacts,
): {
  requiresAnalysis: boolean;
  referenceState: boolean;
  reasons: readonly string[];
} => {
  if (call.targets.length === 0) {
    if (call.intrinsicBoundary) {
      return {
        requiresAnalysis: call.formsExplicitBorrow,
        referenceState: false,
        reasons: call.formsExplicitBorrow ? ["explicit-borrow"] : [],
      };
    }
    const contract = call.baseContract;
    if (!contract) {
      return {
        requiresAnalysis: true,
        referenceState: true,
        reasons: ["unknown-contract"],
      };
    }
    const reasons = borrowDemandReasons({
      contract,
      resultIsConsumed,
      call,
      facts,
      typing: resolveContext.typing,
    });
    return {
      requiresAnalysis: reasons.length > 0,
      referenceState:
        contract.externalRead === true ||
        contract.externalWrite === true ||
        contract.parameters.some(
          (parameter, index) =>
            parameter.access === "mutable" ||
            (parameter.access !== "owned" &&
              callParameterCanAffectBorrow({
                call,
                parameter: index,
                facts,
                typing: resolveContext.typing,
              })),
        ),
      reasons,
    };
  }
  const contracts = call.targets.map((target) =>
    target.moduleId === resolveContext.moduleId
      ? resolveContext.contracts.get(target.symbol)
      : resolveContext.dependencies
          .get(target.moduleId)
          ?.callables.get(target.symbol)?.contract,
  );
  const effects = call.targets.map((target) =>
    target.moduleId === resolveContext.moduleId
      ? undefined
      : resolveContext.dependencies
          .get(target.moduleId)
          ?.effectOperations.get(target.symbol),
  );
  const reasons = new Set<string>();
  if (call.formsExplicitBorrow) reasons.add("explicit-borrow");
  if (effects.some((effect) => effect?.maySuspend)) reasons.add("suspension");
  contracts.forEach((contract) => {
    if (!contract) reasons.add("unknown-contract");
    else
      borrowDemandReasons({
        contract,
        resultIsConsumed,
        call,
        facts,
        typing: resolveContext.typing,
      }).forEach((reason) => reasons.add(reason));
  });
  const requiresAnalysis = reasons.size > 0;
  const referenceState =
    call.formsExplicitBorrow ||
    contracts.some(
      (contract) =>
        !contract ||
        contract.externalRead === true ||
        contract.externalWrite === true ||
        contract.parameters.some(
          (parameter, index) =>
            parameter.access === "mutable" ||
            (parameter.access !== "owned" &&
              callParameterCanAffectBorrow({
                call,
                parameter: index,
                facts,
                typing: resolveContext.typing,
              })),
        ),
    );
  return {
    requiresAnalysis,
    referenceState,
    reasons: Array.from(reasons),
  };
};

const callParameterCanAffectBorrow = ({
  call,
  parameter,
  facts,
  typing,
}: {
  call: CallableBorrowCallFact;
  parameter: number;
  facts: CallableBorrowFacts;
  typing: TypingResult;
}): boolean => {
  const argument = call.substitutions.find(
    (candidate) => candidate.parameter === parameter,
  )?.argument;
  if (argument === undefined) return true;
  const type = facts.concreteExpressionTypes.get(argument);
  return (
    type === undefined ||
    typeCanCarryReference(type, typing) ||
    typeContainsBorrowed(type, typing)
  );
};

const borrowDemandReasons = ({
  contract,
  resultIsConsumed,
  call,
  facts,
  typing,
}: {
  contract: CallableBorrowContract;
  resultIsConsumed: boolean;
  call: CallableBorrowCallFact;
  facts: CallableBorrowFacts;
  typing: TypingResult;
}): readonly string[] => {
  const reasons = new Set<string>();
  if (contract.externalWrite) reasons.add("external-write");
  if (contract.maySuspend) reasons.add("suspension");
  if ((contract.scopedCallbacks?.length ?? 0) > 0) reasons.add("callback");
  if (contract.defaultIdentityGuardProtocol !== undefined) {
    reasons.add("default-identity-guard");
  }
  contract.parameters.forEach((parameter, index) => {
    if (parameter.access === "mutable") reasons.add("mutable-access");
    if (
      !callParameterCanAffectBorrow({ call, parameter: index, facts, typing })
    )
      return;
    if ((parameter.writePaths?.length ?? 0) > 0) {
      reasons.add("write-footprint");
    }
    if (parameter.retained) reasons.add("retained");
    if (resultIsConsumed && parameter.returned) reasons.add("returned");
  });
  return Array.from(reasons);
};

const callResultIsConsumed = (
  exprId: HirExprId,
  facts: CallableBorrowFacts,
): boolean =>
  facts.valueUses.has(exprId) ||
  facts.bindingsAfterExpression.has(exprId) ||
  facts.returns.some((returned) => returned.exprId === exprId);
