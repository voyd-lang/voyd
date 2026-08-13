import {
  diagnosticFromCode,
  type Diagnostic,
} from "../../diagnostics/index.js";
import { STD_INTRINSIC_TYPE } from "../../compiler-contracts/index.js";
import type { SymbolTable } from "../binder/index.js";
import {
  walkExpression,
  type HirExpression,
  type HirGraph,
  type HirPattern,
} from "../hir/index.js";
import type { HirExprId, SourceSpan, SymbolId, TypeId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import {
  BORROW_IRRELEVANT_VALUE_INTRINSICS,
  projectedTypes,
} from "./call-resolution.js";
import type {
  CallableBorrowIndex,
  CallableBorrowIndexCall,
} from "./callable-borrow-index.js";
import type { PlaceProjection } from "./model.js";
import {
  joinOrdinaryMutationSummaries,
  type OrdinaryMutationSummary,
} from "./ordinary-mutation-summary.js";

type ExplicitBorrowOrigins = {
  shared: ReadonlySet<number>;
  exclusive: ReadonlySet<number>;
};

const noOrigins = (): ExplicitBorrowOrigins => ({
  shared: new Set(),
  exclusive: new Set(),
});

const mergeOrigins = (
  origins: readonly ExplicitBorrowOrigins[],
): ExplicitBorrowOrigins => ({
  shared: new Set(origins.flatMap((origin) => [...origin.shared])),
  exclusive: new Set(origins.flatMap((origin) => [...origin.exclusive])),
});

const hasOrigins = (origins: ExplicitBorrowOrigins): boolean =>
  origins.shared.size > 0 || origins.exclusive.size > 0;

/**
 * Track only explicit `Borrow<T>` parameter origins inside one callable.
 * The state is intentionally finite: each value carries a pair of parameter
 * bitsets, and no fact crosses a callable or package boundary.
 */
export const checkScopedBorrowLocal = ({
  body,
  callableSpan,
  index,
  hir,
  typing,
  symbolTable,
  moduleId,
  localSummaries,
  importedSummaries,
}: {
  body: HirExprId;
  callableSpan: SourceSpan;
  index: CallableBorrowIndex;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  localSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  importedSummaries: ReadonlyMap<string, OrdinaryMutationSummary>;
}): readonly Diagnostic[] => {
  const borrowedParameters = new Set(
    index.parameters.flatMap((parameter) =>
      typeof parameter.type === "number" &&
      typing.arena.get(typing.arena.unfoldRecursive(parameter.type)).kind ===
        "borrowed"
        ? [parameter.parameter]
        : [],
    ),
  );
  const checksExclusiveBorrowFormation = index.calls.some((call) =>
    call.signature?.parameters.some(
      (parameter) =>
        parameter.bindingKind === "mutable-ref" &&
        typeof parameter.type === "number" &&
        typing.arena.get(typing.arena.unfoldRecursive(parameter.type)).kind ===
          "borrowed",
    ),
  );
  if (borrowedParameters.size === 0 && !checksExclusiveBorrowFormation) {
    return [];
  }

  const originsBySymbol = new Map<SymbolId, ExplicitBorrowOrigins>();
  index.parameterPlaces.forEach(({ parameter, path }, symbol) => {
    if (!borrowedParameters.has(parameter)) return;
    const indexedParameter = index.parameters[parameter];
    if (
      !indexedParameter ||
      !projectionCanCarryOrigin(
        indexedParameter.type,
        path,
        typing,
        symbolTable,
        moduleId,
      )
    ) {
      return;
    }
    originsBySymbol.set(
      symbol,
      indexedParameter.bindingKind === "mutable-ref"
        ? { shared: new Set(), exclusive: new Set([parameter]) }
        : { shared: new Set([parameter]), exclusive: new Set() },
    );
  });

  const callsByExpression = new Map(
    index.calls.map((call) => [call.exprId, call]),
  );
  const expressionType = (expression: HirExprId): TypeId | undefined =>
    typing.borrowResolvedExprTypes.get(expression) ??
    typing.resolvedExprTypes.get(expression) ??
    typing.table.getExprType(expression);
  const expressionCanCarryOrigin = (expression: HirExprId): boolean => {
    const type = expressionType(expression);
    return (
      typeof type !== "number" ||
      !typeIsClosedIndependentValue(type, typing, symbolTable, moduleId)
    );
  };

  let expressionCache = new Map<HirExprId, ExplicitBorrowOrigins>();
  const originsOf = (expressionId: HirExprId): ExplicitBorrowOrigins => {
    const cached = expressionCache.get(expressionId);
    if (cached) return cached;
    const expression = hir.expressions.get(expressionId);
    if (!expression) return noOrigins();
    const result = originsForExpression({
      expression,
      originsBySymbol,
      originsOf,
      expressionCanCarryOrigin,
      callsByExpression,
      hir,
    });
    expressionCache.set(expressionId, result);
    return result;
  };

  const addSymbolOrigins = (
    symbol: SymbolId,
    origins: ExplicitBorrowOrigins,
  ): boolean => {
    if (!hasOrigins(origins)) return false;
    const current = originsBySymbol.get(symbol) ?? noOrigins();
    const merged = mergeOrigins([current, origins]);
    if (
      merged.shared.size === current.shared.size &&
      merged.exclusive.size === current.exclusive.size
    ) {
      return false;
    }
    originsBySymbol.set(symbol, merged);
    return true;
  };

  const bindPattern = ({
    pattern,
    origins,
    sourceType,
    path = [],
  }: {
    pattern: HirPattern;
    origins: ExplicitBorrowOrigins;
    sourceType?: TypeId;
    path?: readonly PlaceProjection[];
  }): boolean => {
    switch (pattern.kind) {
      case "identifier": {
        const candidateType =
          pattern.typeId ??
          (typeof sourceType === "number"
            ? projectedTypes(sourceType, path, typing)[0]
            : undefined);
        if (
          typeof candidateType === "number" &&
          typeIsClosedIndependentValue(
            candidateType,
            typing,
            symbolTable,
            moduleId,
          )
        ) {
          return false;
        }
        return addSymbolOrigins(pattern.symbol, origins);
      }
      case "tuple":
        return pattern.elements
          .map((element, position) =>
            bindPattern({
              pattern: element,
              origins,
              sourceType,
              path: [...path, { kind: "tuple", index: position }],
            }),
          )
          .some(Boolean);
      case "destructure": {
        const fieldsChanged = pattern.fields
          .map((field) =>
            bindPattern({
              pattern: field.pattern,
              origins,
              sourceType,
              path: [...path, { kind: "field", name: field.name }],
            }),
          )
          .some(Boolean);
        const spreadChanged = pattern.spread
          ? bindPattern({ pattern: pattern.spread, origins, sourceType, path })
          : false;
        return fieldsChanged || spreadChanged;
      }
      case "type":
        return pattern.binding
          ? bindPattern({ pattern: pattern.binding, origins, sourceType, path })
          : false;
      case "wildcard":
        return false;
    }
  };

  // Local aliases form a monotone graph. A small fixed point covers forward
  // assignments and loop-carried bindings without building provenance paths.
  const maximumIterations = Math.max(
    1,
    hir.statements.size + hir.expressions.size,
  );
  for (let iteration = 0; iteration < maximumIterations; iteration += 1) {
    let changed = false;
    expressionCache = new Map();
    walkExpression({
      exprId: body,
      hir,
      options: { skipLambdas: true },
      onExitStatement: (_statementId, statement) => {
        if (statement.kind !== "let") return;
        changed =
          bindPattern({
            pattern: statement.pattern,
            origins: originsOf(statement.initializer),
            sourceType: expressionType(statement.initializer),
          }) || changed;
      },
      onExitExpression: (_expressionId, expression) => {
        if (expression.exprKind === "assign" && expression.pattern) {
          changed =
            bindPattern({
              pattern: expression.pattern,
              origins: originsOf(expression.value),
              sourceType: expressionType(expression.value),
            }) || changed;
        }
        if (expression.exprKind === "match") {
          const sourceOrigins = originsOf(expression.discriminant);
          const sourceType = expressionType(expression.discriminant);
          expression.arms.forEach((arm) => {
            changed =
              bindPattern({
                pattern: arm.pattern,
                origins: sourceOrigins,
                sourceType,
              }) || changed;
          });
        }
      },
    });
    if (!changed) break;
  }
  expressionCache = new Map();

  const exclusiveSourceRoots = new Set(
    index.parameters.flatMap((parameter) =>
      parameter.bindingKind === "mutable-ref" ? [parameter.symbol] : [],
    ),
  );
  const sharedCellSourceRoots = new Set<SymbolId>();
  const hasSharedCellWriteGuard = index.calls.some(
    (call) => call.intrinsicName === "__shared_cell_begin_write",
  );
  walkExpression({
    exprId: body,
    hir,
    options: { skipLambdas: true },
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind !== "let") return;
      const symbols = bindingSymbols(statement.pattern);
      if (
        statement.mutable ||
        patternHasBindingKind(statement.pattern, "mutable-ref")
      ) {
        symbols.forEach((symbol) => exclusiveSourceRoots.add(symbol));
      }
      if (
        index.flags.hasRuntimeCheckedReceiverWrites &&
        hasSharedCellWriteGuard &&
        expressionUsesSharedCellValue(
          statement.initializer,
          callsByExpression,
          hir,
        )
      ) {
        symbols.forEach((symbol) => sharedCellSourceRoots.add(symbol));
      }
    },
  });

  const activeOrigins = mergeOrigins(
    Array.from(borrowedParameters, (parameter) =>
      index.parameters[parameter]?.bindingKind === "mutable-ref"
        ? { shared: new Set<number>(), exclusive: new Set([parameter]) }
        : { shared: new Set([parameter]), exclusive: new Set<number>() },
    ),
  );
  const permittedSharedCellCaptureCalls = new Set(
    index.calls.flatMap((call) =>
      callIsScopedSharedCellAccess(call) ? [call.exprId] : [],
    ),
  );
  const permittedSharedCellCaptureSymbols = new Set(
    index.calls.flatMap((call) => {
      if (!permittedSharedCellCaptureCalls.has(call.exprId)) return [];
      const receiver = call.arguments[0];
      return receiver?.place &&
        index.ambientObjectCaptures.includes(receiver.place.root)
        ? [receiver.place.root]
        : [];
    }),
  );

  const diagnostics: Diagnostic[] = [];
  const diagnosticKeys = new Set<string>();
  const reportEscape = ({
    origins,
    span,
    through,
  }: {
    origins: ExplicitBorrowOrigins;
    span: SourceSpan;
    through: string;
  }): void => {
    const parameter = firstOrigin(origins);
    if (parameter === undefined) return;
    const binding = symbolName(
      index.parameters[parameter]?.symbol,
      symbolTable,
    );
    const diagnostic = diagnosticFromCode({
      code: "TY0051",
      params: { kind: "explicit-borrow-escape", binding, through },
      span,
      related: [
        diagnosticFromCode({
          code: "TY0051",
          params: { kind: "borrow-origin", binding },
          span: callableSpan,
          severity: "note",
        }),
      ],
    });
    pushUniqueDiagnostic(diagnostic, diagnostics, diagnosticKeys);
  };
  const reportSharedUpgrade = ({
    origins,
    span,
  }: {
    origins: ExplicitBorrowOrigins;
    span: SourceSpan;
  }): void => {
    const parameter = origins.shared.values().next().value as
      | number
      | undefined;
    if (parameter === undefined) return;
    const diagnostic = diagnosticFromCode({
      code: "TY0050",
      params: {
        kind: "mutable-borrow-from-shared",
        binding: symbolName(index.parameters[parameter]?.symbol, symbolTable),
      },
      span,
    });
    pushUniqueDiagnostic(diagnostic, diagnostics, diagnosticKeys);
  };

  const reportInvalidExclusiveSource = ({
    root,
    span,
  }: {
    root?: SymbolId;
    span: SourceSpan;
  }): void => {
    const diagnostic = diagnosticFromCode({
      code: "TY0050",
      params: {
        kind: "mutable-borrow-from-shared",
        binding:
          typeof root === "number"
            ? symbolName(root, symbolTable)
            : "temporary or immutable value",
      },
      span,
    });
    pushUniqueDiagnostic(diagnostic, diagnostics, diagnosticKeys);
  };

  const reportBoundary = (span: SourceSpan, through: string): void =>
    reportEscape({ origins: activeOrigins, span, through });

  const checkCall = (
    expression: Extract<HirExpression, { exprKind: "call" | "method-call" }>,
  ): void => {
    const call = callsByExpression.get(expression.id);
    if (!call) return;
    if (
      call.intrinsicName !== undefined &&
      BORROW_IRRELEVANT_VALUE_INTRINSICS.has(call.intrinsicName)
    ) {
      return;
    }
    if (isTransparentOriginIntrinsic(call.intrinsicName)) return;

    const callableOrigins =
      expression.exprKind === "call"
        ? originsOf(expression.callee)
        : noOrigins();
    if (hasOrigins(callableOrigins)) {
      reportEscape({
        origins: callableOrigins,
        span: expression.span,
        through: "invoking a callable projected from borrowed data",
      });
    }

    const boundary = scopedBoundaryForCall({
      expression,
      call,
      hir,
      symbolTable,
      moduleId,
      localSummaries,
      importedSummaries,
      permitScopedSharedCellAccess: permittedSharedCellCaptureCalls.has(
        call.exprId,
      ),
    });
    if (boundary) reportBoundary(expression.span, boundary);

    const checkedExpressions = new Set<HirExprId>();
    call.arguments.forEach((argument) => {
      if (typeof argument.expression !== "number") return;
      checkedExpressions.add(argument.expression);
      const origins = originsOf(argument.expression);
      const parameter = call.signature?.parameters[argument.parameter];
      const borrowed =
        typeof parameter?.type === "number" &&
        typing.arena.get(typing.arena.unfoldRecursive(parameter.type)).kind ===
          "borrowed";
      if (borrowed && parameter.bindingKind === "mutable-ref") {
        if (origins.shared.size > 0) {
          reportSharedUpgrade({ origins, span: expression.span });
        } else if (origins.exclusive.size === 0) {
          const eligibleRoot = argument.place?.root;
          const eligible =
            (typeof eligibleRoot === "number" &&
              (exclusiveSourceRoots.has(eligibleRoot) ||
                sharedCellSourceRoots.has(eligibleRoot))) ||
            (index.flags.hasRuntimeCheckedReceiverWrites &&
              hasSharedCellWriteGuard &&
              expressionUsesSharedCellValue(
                argument.expression,
                callsByExpression,
                hir,
              ));
          if (!eligible) {
            reportInvalidExclusiveSource({
              root: eligibleRoot,
              span: expression.span,
            });
          }
        }
      }
      if (!hasOrigins(origins)) return;
      if (!borrowed) {
        reportEscape({
          origins,
          span: expression.span,
          through: "an ordinary callable boundary",
        });
        return;
      }
    });

    if (
      expression.exprKind === "method-call" &&
      !checkedExpressions.has(expression.target)
    ) {
      reportEscape({
        origins: originsOf(expression.target),
        span: expression.span,
        through: "ordinary method dispatch",
      });
    }
  };

  walkExpression({
    exprId: body,
    hir,
    options: { skipLambdas: true },
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind === "return" && typeof statement.value === "number") {
        reportEscape({
          origins: escapingOriginsOf({
            expression: statement.value,
            originsOf,
            expressionType,
            typing,
            symbolTable,
            moduleId,
          }),
          span: statement.span,
          through: "this return",
        });
      }
    },
    onEnterExpression: (_expressionId, expression) => {
      if (
        expression.exprKind === "call" ||
        expression.exprKind === "method-call"
      ) {
        checkCall(expression);
      }
      if (expression.exprKind === "lambda") {
        const captured = mergeOrigins(
          expression.captures.map(
            (capture) => originsBySymbol.get(capture.symbol) ?? noOrigins(),
          ),
        );
        reportEscape({
          origins: captured,
          span: expression.span,
          through: "a closure capture",
        });
      }
    },
  });
  if (index.flags.hasModuleStorageAccess) {
    reportBoundary(callableSpan, "ambient module storage access");
  }
  if (
    index.ambientObjectCaptures.some(
      (symbol) => !permittedSharedCellCaptureSymbols.has(symbol),
    )
  ) {
    reportBoundary(callableSpan, "an ambient-capturing callable");
  }
  reportEscape({
    origins: escapingOriginsOf({
      expression: body,
      originsOf,
      expressionType,
      typing,
      symbolTable,
      moduleId,
    }),
    span: hir.expressions.get(body)?.span ?? callableSpan,
    through: "this return",
  });
  return diagnostics;
};

const originsForExpression = ({
  expression,
  originsBySymbol,
  originsOf,
  expressionCanCarryOrigin,
  callsByExpression,
  hir,
}: {
  expression: HirExpression;
  originsBySymbol: ReadonlyMap<SymbolId, ExplicitBorrowOrigins>;
  originsOf: (expression: HirExprId) => ExplicitBorrowOrigins;
  expressionCanCarryOrigin: (expression: HirExprId) => boolean;
  callsByExpression: ReadonlyMap<HirExprId, CallableBorrowIndexCall>;
  hir: HirGraph;
}): ExplicitBorrowOrigins => {
  switch (expression.exprKind) {
    case "identifier":
      return originsBySymbol.get(expression.symbol) ?? noOrigins();
    case "field-access":
      return expressionCanCarryOrigin(expression.id)
        ? originsOf(expression.target)
        : noOrigins();
    case "tuple":
      return mergeOrigins(expression.elements.map(originsOf));
    case "object-literal":
      return mergeOrigins(
        expression.entries.map((entry) => originsOf(entry.value)),
      );
    case "call": {
      const call = callsByExpression.get(expression.id);
      if (!call || !expressionCanCarryOrigin(expression.id)) return noOrigins();
      if (isTransparentOriginIntrinsic(call.intrinsicName)) {
        const source = call.arguments.find(
          (argument) => typeof argument.expression === "number",
        )?.expression;
        return typeof source === "number" ? originsOf(source) : noOrigins();
      }
      if (call.returnsBorrowed) {
        return mergeOrigins(
          call.arguments.flatMap((argument) =>
            typeof argument.expression === "number"
              ? [originsOf(argument.expression)]
              : [],
          ),
        );
      }
      return noOrigins();
    }
    case "method-call":
      return noOrigins();
    case "block":
      return typeof expression.value === "number"
        ? originsOf(expression.value)
        : noOrigins();
    case "if":
    case "cond":
      return mergeOrigins([
        ...expression.branches.map((branch) => originsOf(branch.value)),
        ...(typeof expression.defaultBranch === "number"
          ? [originsOf(expression.defaultBranch)]
          : []),
      ]);
    case "match":
      return mergeOrigins(expression.arms.map((arm) => originsOf(arm.value)));
    case "effect-handler":
      return mergeOrigins([
        originsOf(expression.body),
        ...expression.handlers.map((handler) => originsOf(handler.body)),
        ...(typeof expression.finallyBranch === "number"
          ? [originsOf(expression.finallyBranch)]
          : []),
      ]);
    case "assign":
      return originsOf(expression.value);
    case "break":
      return typeof expression.value === "number"
        ? originsOf(expression.value)
        : noOrigins();
    case "loop": {
      const breakOrigins: ExplicitBorrowOrigins[] = [];
      walkExpression({
        exprId: expression.body,
        hir,
        options: { skipLambdas: true },
        onEnterExpression: (_expressionId, nested) => {
          if (nested.exprKind === "break" && typeof nested.value === "number") {
            breakOrigins.push(originsOf(nested.value));
          }
        },
      });
      return mergeOrigins(breakOrigins);
    }
    case "literal":
    case "overload-set":
    case "while":
    case "lambda":
    case "continue":
      return noOrigins();
  }
};

const isTransparentOriginIntrinsic = (name: string | undefined): boolean =>
  name === "~" || name === "__array_get" || name === "__array_copy";

const projectionCanCarryOrigin = (
  sourceType: TypeId | undefined,
  path: readonly PlaceProjection[],
  typing: TypingResult,
  symbolTable: SymbolTable,
  moduleId: string,
): boolean => {
  if (typeof sourceType !== "number" || path.length === 0) return true;
  const projected = projectedTypes(sourceType, path, typing);
  return (
    projected.length === 0 ||
    projected.some(
      (type) =>
        !typeIsClosedIndependentValue(type, typing, symbolTable, moduleId),
    )
  );
};

const scopedBoundaryForCall = ({
  expression,
  call,
  hir,
  symbolTable,
  moduleId,
  localSummaries,
  importedSummaries,
  permitScopedSharedCellAccess,
}: {
  expression: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  call: CallableBorrowIndexCall;
  hir: HirGraph;
  symbolTable: SymbolTable;
  moduleId: string;
  localSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  importedSummaries: ReadonlyMap<string, OrdinaryMutationSummary>;
  permitScopedSharedCellAccess: boolean;
}): string | undefined => {
  if (callIsExternal(expression, hir, symbolTable)) {
    return "an external or host call";
  }
  if (
    call.intrinsicName !== undefined &&
    isTaskOrRetainedCallbackBoundary(call.intrinsicName)
  ) {
    return "a task, host callback, or continuation boundary";
  }
  if (
    (expression.exprKind === "call" &&
      expression.effectOperation !== undefined) ||
    call.targets.some(
      (target) =>
        target.moduleId === moduleId &&
        symbolTable.hasSymbol(target.symbol) &&
        symbolTable.getSymbol(target.symbol).kind === "effect-op",
    ) ||
    call.maySuspend
  ) {
    return "an effect, suspension, or continuation boundary";
  }
  if (
    !call.intrinsic &&
    (call.targets.length === 0 ||
      call.openTraitDispatch === true ||
      call.argumentPlanAmbiguous === true)
  ) {
    return "unknown callback or open dispatch";
  }
  if (call.intrinsic) return undefined;
  if (permitScopedSharedCellAccess) return undefined;
  const summary = completeSummaryForCall({
    call,
    moduleId,
    localSummaries,
    importedSummaries,
  });
  if (!summary) return "a callable with unavailable safety information";
  if (summary.ambientObjectAccess) {
    return "a helper that accesses ambient module state";
  }
  if (summary.invokesUnknownCallback) {
    return "a helper that invokes an unknown callback";
  }
  return summary.maySuspend
    ? "a helper that may suspend or perform an effect"
    : undefined;
};

const callIsScopedSharedCellAccess = (call: CallableBorrowIndexCall): boolean =>
  call.scopedSharedCellAccess === true;

const completeSummaryForCall = ({
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
  const summaries = call.targets.flatMap((target) => {
    const summary =
      target.moduleId === moduleId
        ? localSummaries.get(target.symbol)
        : importedSummaries.get(`${target.moduleId}::${target.symbol}`);
    return summary ? [summary] : [];
  });
  if (summaries.length !== call.targets.length || summaries.length === 0) {
    return undefined;
  }
  return summaries
    .slice(1)
    .reduce(
      (summary, candidate) => joinOrdinaryMutationSummaries(summary, candidate),
      summaries[0]!,
    );
};

const callIsExternal = (
  expression: Extract<HirExpression, { exprKind: "call" | "method-call" }>,
  hir: HirGraph,
  symbolTable: SymbolTable,
): boolean => {
  if (expression.exprKind !== "call") return false;
  const callee = hir.expressions.get(expression.callee);
  if (callee?.exprKind !== "identifier") return false;
  const metadata = symbolTable.getSymbol(callee.symbol).metadata as
    | { externalFunction?: unknown }
    | undefined;
  return metadata?.externalFunction !== undefined;
};

const isTaskOrRetainedCallbackBoundary = (intrinsicName: string): boolean =>
  intrinsicName.startsWith("__task_") ||
  intrinsicName === "__retain_callback" ||
  intrinsicName === "__host_retain_callback" ||
  intrinsicName === "__render_retain_callback" ||
  intrinsicName === "__render_claim_callback";

const escapingOriginsOf = ({
  expression,
  originsOf,
  expressionType,
  typing,
  symbolTable,
  moduleId,
}: {
  expression: HirExprId;
  originsOf: (expression: HirExprId) => ExplicitBorrowOrigins;
  expressionType: (expression: HirExprId) => TypeId | undefined;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
}): ExplicitBorrowOrigins => {
  const type = expressionType(expression);
  if (
    typeof type === "number" &&
    typeIsClosedIndependentEscape(type, typing, symbolTable, moduleId)
  ) {
    return noOrigins();
  }
  return originsOf(expression);
};

const typeIsClosedIndependentEscape = (
  type: TypeId,
  typing: TypingResult,
  symbolTable: SymbolTable,
  moduleId: string,
): boolean => {
  const descriptor = typing.arena.get(typing.arena.unfoldRecursive(type));
  return descriptor.kind === "borrowed"
    ? typeIsClosedIndependentValue(
        descriptor.inner,
        typing,
        symbolTable,
        moduleId,
      )
    : typeIsClosedIndependentValue(type, typing, symbolTable, moduleId);
};

const typeIsClosedIndependentValue = (
  type: TypeId,
  typing: TypingResult,
  symbolTable: SymbolTable,
  moduleId: string,
  active = new Set<TypeId>(),
): boolean => {
  const normalized = typing.arena.unfoldRecursive(type);
  if (active.has(normalized)) return false;
  const descriptor = typing.arena.get(normalized);
  if (descriptor.kind === "primitive") {
    return descriptor.name !== "unknown";
  }
  if (descriptor.kind === "borrowed") return false;
  if (typeIsStableStringSlice(normalized, typing, symbolTable, moduleId)) {
    return true;
  }
  const nextActive = new Set(active).add(normalized);
  if (descriptor.kind === "value-object") {
    const fields = typing.objectsByNominal.get(normalized)?.fields;
    return (
      fields !== undefined &&
      fields.every((field) =>
        typeIsClosedIndependentValue(
          field.type,
          typing,
          symbolTable,
          moduleId,
          nextActive,
        ),
      )
    );
  }
  if (descriptor.kind === "structural-object") {
    return descriptor.fields.every((field) =>
      typeIsClosedIndependentValue(
        field.type,
        typing,
        symbolTable,
        moduleId,
        nextActive,
      ),
    );
  }
  if (descriptor.kind === "intersection") {
    if (typeof descriptor.nominal === "number") {
      return typeIsClosedIndependentValue(
        descriptor.nominal,
        typing,
        symbolTable,
        moduleId,
        nextActive,
      );
    }
    return (
      typeof descriptor.structural === "number" &&
      typeIsClosedIndependentValue(
        descriptor.structural,
        typing,
        symbolTable,
        moduleId,
        nextActive,
      )
    );
  }
  return false;
};

const typeIsStableStringSlice = (
  type: TypeId,
  typing: TypingResult,
  symbolTable: SymbolTable,
  moduleId: string,
): boolean => {
  const nominal = typing.arena.nominalComponent(type) ?? type;
  const known = typing.intrinsicTypes.get(STD_INTRINSIC_TYPE.stringSlice);
  const knownNominal =
    typeof known === "number"
      ? (typing.arena.nominalComponent(known) ?? known)
      : undefined;
  if (knownNominal === nominal) return true;
  const descriptor = typing.arena.get(nominal);
  if (
    descriptor.kind !== "nominal-object" &&
    descriptor.kind !== "value-object"
  ) {
    return false;
  }
  const ownerSymbol =
    descriptor.owner.moduleId === moduleId
      ? descriptor.owner.symbol
      : symbolTable.snapshot().symbols.find((record) => {
          const metadata = record.metadata as
            | { import?: { moduleId?: unknown; symbol?: unknown } }
            | undefined;
          return (
            metadata?.import?.moduleId === descriptor.owner.moduleId &&
            metadata.import.symbol === descriptor.owner.symbol
          );
        })?.id;
  if (ownerSymbol === undefined || !symbolTable.hasSymbol(ownerSymbol)) {
    return false;
  }
  const metadata = symbolTable.getSymbol(ownerSymbol).metadata as
    | { intrinsicType?: unknown }
    | undefined;
  return metadata?.intrinsicType === STD_INTRINSIC_TYPE.stringSlice;
};

const bindingSymbols = (pattern: HirPattern): readonly SymbolId[] => {
  switch (pattern.kind) {
    case "identifier":
      return [pattern.symbol];
    case "tuple":
      return pattern.elements.flatMap(bindingSymbols);
    case "destructure":
      return [
        ...pattern.fields.flatMap((field) => bindingSymbols(field.pattern)),
        ...(pattern.spread ? bindingSymbols(pattern.spread) : []),
      ];
    case "type":
      return pattern.binding ? bindingSymbols(pattern.binding) : [];
    case "wildcard":
      return [];
  }
};

const patternHasBindingKind = (
  pattern: HirPattern,
  bindingKind: "mutable-ref" | "immutable-ref",
): boolean => {
  if (pattern.bindingKind === bindingKind) return true;
  switch (pattern.kind) {
    case "tuple":
      return pattern.elements.some((entry) =>
        patternHasBindingKind(entry, bindingKind),
      );
    case "destructure":
      return (
        pattern.fields.some((field) =>
          patternHasBindingKind(field.pattern, bindingKind),
        ) ||
        (pattern.spread !== undefined &&
          patternHasBindingKind(pattern.spread, bindingKind))
      );
    case "type":
      return (
        pattern.binding !== undefined &&
        patternHasBindingKind(pattern.binding, bindingKind)
      );
    case "identifier":
    case "wildcard":
      return false;
  }
};

const expressionUsesSharedCellValue = (
  expression: HirExprId,
  callsByExpression: ReadonlyMap<HirExprId, CallableBorrowIndexCall>,
  hir: HirGraph,
): boolean => {
  const call = callsByExpression.get(expression);
  if (call?.intrinsicName === "__shared_cell_value") return true;
  if (call?.intrinsicName !== "~") return false;
  const node = hir.expressions.get(expression);
  const source = node?.exprKind === "call" ? node.args.at(-1)?.expr : undefined;
  return typeof source === "number"
    ? expressionUsesSharedCellValue(source, callsByExpression, hir)
    : false;
};

const firstOrigin = (origins: ExplicitBorrowOrigins): number | undefined =>
  origins.shared.values().next().value ??
  origins.exclusive.values().next().value;

const symbolName = (
  symbol: SymbolId | undefined,
  symbolTable: SymbolTable,
): string =>
  typeof symbol === "number" && symbolTable.hasSymbol(symbol)
    ? symbolTable.getSymbol(symbol).name
    : "borrowed value";

const pushUniqueDiagnostic = (
  diagnostic: Diagnostic,
  diagnostics: Diagnostic[],
  keys: Set<string>,
): void => {
  const key = `${diagnostic.code}:${diagnostic.span.start}:${diagnostic.span.end}`;
  if (keys.has(key)) return;
  keys.add(key);
  diagnostics.push(diagnostic);
};
