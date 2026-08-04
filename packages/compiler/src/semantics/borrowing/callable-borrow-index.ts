import {
  walkExpression,
  type HirExpression,
  type HirFunction,
  type HirGraph,
  type HirLambdaExpr,
  type HirPattern,
} from "../hir/index.js";
import type { HirExprId, SymbolId, TypeId } from "../ids.js";
import type { SourceSpan } from "../ids.js";
import { STD_INTRINSIC_TYPE } from "../../compiler-contracts/index.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import type { SymbolTable } from "../binder/index.js";
import type { DeclTable } from "../decls.js";
import type { FunctionSignature, TypingResult } from "../typing/index.js";
import { bindCallArgumentExpressions } from "../typing/call-argument-binding.js";
import type { CallArgumentPlanEntry } from "../typing/types.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import {
  expressionTypeFor,
  type ResolveContext,
} from "./call-resolution.js";
import type {
  BorrowAccessMode,
  BorrowPlace,
  CallableBorrowContract,
  PlaceProjection,
} from "./model.js";
import {
  typeCanCarryReference,
  typeIsAllocationBacked,
} from "./reference-bearing.js";
import { typeContainsBorrowed } from "./borrowed-types.js";
import { BORROW_IRRELEVANT_VALUE_INTRINSICS } from "./call-resolution.js";
import { placeOfExpression } from "./places.js";

export type CallableBorrowIndexAccess = {
  exprId: HirExprId;
  kind: "read" | "write";
  place?: BorrowPlace;
  role?:
    | "projection-base"
    | "call-operand"
    | "call-argument"
    | "assignment-target";
  referenceArgument?: true;
};

export type CallableBorrowIndexArgument = {
  parameter: number;
  expression?: HirExprId;
  place?: BorrowPlace;
  type?: TypeId;
  loanBearing?: true;
  defaulted?: true;
};

export type CallableBorrowIndexCall = {
  exprId: HirExprId;
  span: SourceSpan;
  targets: readonly SymbolRef[];
  arguments: readonly CallableBorrowIndexArgument[];
  signature?: Pick<
    FunctionSignature,
    "parameters" | "returnType" | "effectRow"
  >;
  intrinsic: boolean;
  intrinsicBoundary: boolean;
  intrinsicName?: string;
  intrinsicIndex?: PlaceProjection;
  formsExplicitBorrow: boolean;
  returnsBorrowed: boolean;
  resultUse: "ignored" | "immediate" | "escapes-or-ambiguous";
  maySuspend: boolean;
  argumentPlanAmbiguous?: true;
  traitDispatch?: true;
  openTraitDispatch?: true;
};

export type CallableBorrowIndexFlags = {
  hasBorrowOperation: boolean;
  hasBorrowedBinding: boolean;
  hasBorrowedReturn: boolean;
  hasBorrowedStore: boolean;
  hasUnsafeBorrowFormation: boolean;
  hasMutableParameter: boolean;
  hasMutableBinding: boolean;
  /** A mutable reference-capable binding sourced from a non-fresh expression. */
  hasNonFreshMutableBinding: boolean;
  hasReferenceBinding: boolean;
  hasRetainedReferenceStore: boolean;
  hasMutableReferenceRebinding: boolean;
  hasNonFreshMutableReferenceRebinding: boolean;
  hasCapture: boolean;
  hasRetention: boolean;
  hasSuspension: boolean;
  hasModuleStorageAccess: boolean;
  hasModuleStorageWrite: boolean;
  hasModuleStorageBorrow: boolean;
  hasUnresolvedBehavior: boolean;
  hasOpenDispatch: boolean;
  hasUnknownBehavior: boolean;
  hasDefaultArgument: boolean;
  hasDefaultBorrowFlow: boolean;
  hasRuntimeCheckedReceiverWrites: boolean;
  hasFreshResult: boolean;
  hasTraitResult: boolean;
  hasCallableResult: boolean;
  hasReturnedParameterValue: boolean;
  hasSimplePlainReturn: boolean;
};

export type CallableBorrowIndexParameter = {
  symbol: SymbolId;
  parameter: number;
  bindingKind?: "value" | "mutable-ref" | "immutable-ref";
  type?: TypeId;
  defaulted: boolean;
  access: BorrowAccessMode;
  loanBearing?: true;
};

/**
 * Cheap immutable input to capability classification and transient contract
 * composition. It intentionally contains no expression/statement maps, CFG,
 * liveness, provenance graph, type fingerprint, or solver-private state.
 */
export type CallableBorrowIndex = {
  symbol: SymbolId;
  signature?: Pick<
    FunctionSignature,
    "parameters" | "returnType" | "effectRow"
  >;
  declaredContract?: HirFunction["borrowContract"];
  parameters: readonly CallableBorrowIndexParameter[];
  parameterPlaces: ReadonlyMap<
    SymbolId,
    { parameter: number; path: readonly PlaceProjection[] }
  >;
  accesses: readonly CallableBorrowIndexAccess[];
  calls: readonly CallableBorrowIndexCall[];
  directCallEdges: readonly SymbolRef[];
  flags: CallableBorrowIndexFlags;
};

type IndexCallable = Pick<
  HirFunction,
  "symbol" | "parameters" | "body" | "borrowContract"
> & {
  type?: TypeId;
  captures?: HirLambdaExpr["captures"];
};

type MutableFlags = {
  -readonly [Key in keyof CallableBorrowIndexFlags]: boolean;
};

const emptyFlags = (): MutableFlags => ({
  hasBorrowOperation: false,
  hasBorrowedBinding: false,
  hasBorrowedReturn: false,
  hasBorrowedStore: false,
  hasUnsafeBorrowFormation: false,
  hasMutableParameter: false,
  hasMutableBinding: false,
  hasNonFreshMutableBinding: false,
  hasReferenceBinding: false,
  hasRetainedReferenceStore: false,
  hasMutableReferenceRebinding: false,
  hasNonFreshMutableReferenceRebinding: false,
  hasCapture: false,
  hasRetention: false,
  hasSuspension: false,
  hasModuleStorageAccess: false,
  hasModuleStorageWrite: false,
  hasModuleStorageBorrow: false,
  hasUnresolvedBehavior: false,
  hasOpenDispatch: false,
  hasUnknownBehavior: false,
  hasDefaultArgument: false,
  hasDefaultBorrowFlow: false,
  hasRuntimeCheckedReceiverWrites: false,
  hasFreshResult: false,
  hasTraitResult: false,
  hasCallableResult: false,
  hasReturnedParameterValue: false,
  hasSimplePlainReturn: false,
});

const parameterPlacesFor = (
  parameters: readonly { pattern: HirPattern }[],
): ReadonlyMap<
  SymbolId,
  { parameter: number; path: readonly PlaceProjection[] }
> => {
  const result = new Map<
    SymbolId,
    { parameter: number; path: readonly PlaceProjection[] }
  >();
  const visit = (
    pattern: HirPattern,
    parameter: number,
    path: readonly PlaceProjection[] = [],
  ): void => {
    switch (pattern.kind) {
      case "identifier":
        result.set(pattern.symbol, { parameter, path });
        return;
      case "tuple":
        pattern.elements.forEach((element, index) =>
          visit(element, parameter, [
            ...path,
            { kind: "tuple", index },
          ]),
        );
        return;
      case "destructure":
        pattern.fields.forEach((field) =>
          visit(field.pattern, parameter, [
            ...path,
            { kind: "field", name: field.name },
          ]),
        );
        if (pattern.spread) visit(pattern.spread, parameter, path);
        return;
      case "type":
        if (pattern.binding) visit(pattern.binding, parameter, path);
        return;
      case "wildcard":
        return;
    }
  };
  parameters.forEach((parameter, index) => visit(parameter.pattern, index));
  return result;
};

const typeFor = (
  expression: HirExprId,
  resolveContext: ResolveContext,
): TypeId | undefined => expressionTypeFor(expression, resolveContext);

const sameBoundCallArguments = (
  left: readonly (HirExprId | undefined)[],
  right: readonly (HirExprId | undefined)[],
): boolean =>
  left.length === right.length &&
  left.every((entry, index) => {
    const candidate = right[index];
    return entry === candidate;
  });

const isModuleStorage = ({
  symbol,
  symbolTable,
  typing,
}: {
  symbol: SymbolId;
  symbolTable: SymbolTable;
  typing: TypingResult;
}): boolean => {
  const record = symbolTable.getSymbol(symbol);
  if (record.kind !== "value") return false;
  if ((record.metadata as { intrinsic?: boolean } | undefined)?.intrinsic) {
    return false;
  }
  return (
    symbolTable.getScope(record.scope).kind === "module" &&
    typing.functions.getSignature(symbol) === undefined
  );
};

const callIntrinsicName = (
  expression: Extract<HirExpression, { exprKind: "call" }>,
  resolveContext: ResolveContext,
): string | undefined => {
  const callee = resolveContext.hir.expressions.get(expression.callee);
  if (callee?.exprKind !== "identifier") return undefined;
  const record = resolveContext.symbolTable.getSymbol(callee.symbol);
  const metadata = record.metadata as
    | { intrinsic?: boolean; intrinsicName?: string }
    | undefined;
  return metadata?.intrinsic === true
    ? (metadata.intrinsicName ?? record.name)
    : undefined;
};

const isBorrowedType = (
  type: TypeId | undefined,
  typing: TypingResult,
): boolean => typeof type === "number" && typeContainsBorrowed(type, typing);

const isLoanBearingType = (
  type: TypeId | undefined,
  typing: TypingResult,
): boolean =>
  typeof type === "number" &&
  (isBorrowedType(type, typing) || typing.arena.get(type).kind === "type-param-ref");

const isBorrowCapableType = (
  type: TypeId | undefined,
  typing: TypingResult,
): boolean =>
  typeof type === "number" &&
  (typeContainsBorrowed(type, typing) || typeCanCarryReference(type, typing));

const normalizeIndex = (
  index: CallableBorrowIndex,
): CallableBorrowIndex => ({
  ...index,
  parameters: [...index.parameters],
  accesses: [...index.accesses],
  calls: [...index.calls],
  directCallEdges: [...index.directCallEdges],
  flags: { ...index.flags },
});

export const extractCallableBorrowIndex = ({
  callables,
  hir,
  typing,
  symbolTable,
  decls,
  resolveContext,
}: {
  callables: readonly IndexCallable[];
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  decls: DeclTable;
  resolveContext: ResolveContext;
}): ReadonlyMap<SymbolId, CallableBorrowIndex> =>
  new Map(
    callables.map((callable) => [
      callable.symbol,
      extractSingleCallableBorrowIndex({
        callable,
        hir,
        typing,
        symbolTable,
        decls,
        resolveContext,
      }),
    ]),
  );

export const extractSingleCallableBorrowIndex = ({
  callable,
  hir,
  typing,
  symbolTable,
  decls,
  resolveContext,
}: {
  callable: IndexCallable;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  decls: DeclTable;
  resolveContext: ResolveContext;
}): CallableBorrowIndex => {
  const context: ResolveContext = {
    ...resolveContext,
    hir,
    typing,
    symbolTable,
    decls,
    borrowIndexMode: "symbolic",
    callResolutionCache: undefined,
  };
  const callableType =
    callable.type !== undefined ? typing.arena.get(callable.type) : undefined;
  const signature =
    typing.functions.getSignature(callable.symbol) ??
    (callableType?.kind === "function"
      ? {
          parameters: callableType.parameters,
          returnType: callableType.returnType,
          effectRow: callableType.effectRow,
        }
      : undefined);
  const parameters = callable.parameters.map((parameter, index) => {
    const type = signature?.parameters[index]?.type;
    const bindingKind = parameter.pattern.bindingKind;
    return {
      symbol: parameter.symbol,
      parameter: index,
      ...(bindingKind ? { bindingKind } : {}),
      ...(typeof type === "number" ? { type } : {}),
      defaulted: typeof parameter.defaultValue === "number",
      ...(bindingKind === "mutable-ref" ||
      bindingKind === "immutable-ref" ||
      isBorrowedType(type, typing)
        ? { loanBearing: true as const }
        : {}),
      access:
        bindingKind === "mutable-ref"
          ? ("mutable" as const)
          : isLoanBearingType(type, typing)
            ? ("shared" as const)
            : ("owned" as const),
    } satisfies CallableBorrowIndexParameter;
  });
  const flags = emptyFlags();
  flags.hasMutableParameter = parameters.some(
    (parameter) => parameter.bindingKind === "mutable-ref",
  );
  flags.hasDefaultArgument = parameters.some((parameter) => parameter.defaulted);
  flags.hasBorrowOperation =
    flags.hasMutableParameter ||
    parameters.some(
      (parameter) =>
        parameter.bindingKind === "immutable-ref" ||
        isBorrowedType(parameter.type, typing),
    );
  if (signature === undefined) flags.hasUnknownBehavior = true;
  if (
    signature !== undefined &&
    typing.arena.containsTypeParams(signature.returnType)
  ) {
    // A generic result may become a borrowed value after instantiation. The
    // cheap route cannot resolve that provenance without full facts.
    flags.hasUnknownBehavior = true;
  }
  if (
    signature !== undefined &&
    typing.arena.get(signature.returnType).kind === "trait"
  ) {
    // Trait results carry an open implementation contract. Their concrete
    // returned regions cannot be represented by the compact footprint.
    flags.hasTraitResult = true;
  }
  const accesses: CallableBorrowIndexAccess[] = [];
  const calls: CallableBorrowIndexCall[] = [];
  const directCallEdges = new Map<string, SymbolRef>();
  const parameterPlaces = parameterPlacesFor(callable.parameters);
  const traitMethodSymbols = new Set(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "trait" ? item.methods.map((method) => method.symbol) : [],
    ),
  );
  const isStoragePlace = (place: BorrowPlace | undefined): boolean =>
    place !== undefined &&
    !parameterPlaces.has(place.root) &&
    isModuleStorage({ symbol: place.root, symbolTable, typing });
  const roleForChild = (
    parentId: HirExprId | undefined,
    childId: HirExprId,
  ): CallableBorrowIndexAccess["role"] => {
    const parent =
      parentId === undefined ? undefined : hir.expressions.get(parentId);
    if (!parent) return undefined;
    if (parent.exprKind === "call") {
      if (parent.callee === childId) return "call-operand";
      if (parent.args.some((argument) => argument.expr === childId)) {
        return "call-argument";
      }
    }
    if (parent.exprKind === "method-call") {
      if (parent.target === childId) return "call-operand";
      if (parent.args.some((argument) => argument.expr === childId)) {
        return "call-argument";
      }
    }
    if (parent.exprKind === "assign") {
      if (parent.target === childId) return "assignment-target";
    }
    if (parent.exprKind === "field-access" && parent.target === childId) {
      return "projection-base";
    }
    if (
      (parent.exprKind === "object-literal" &&
        parent.entries.some((entry) => entry.value === childId)) ||
      (parent.exprKind === "tuple" && parent.elements.includes(childId))
    ) {
      return "call-operand";
    }
    return undefined;
  };
  const roleForExpression = (
    expressionId: HirExprId,
    parentId: HirExprId | undefined,
  ): CallableBorrowIndexAccess["role"] =>
    roleForChild(parentId, expressionId);
  const recordAccess = (
    exprId: HirExprId,
    kind: CallableBorrowIndexAccess["kind"],
    expression: HirExprId,
    parentId?: HirExprId,
  ): void => {
    const place = placeOfExpression(expression, hir, context);
    const role = roleForExpression(expression, parentId);
    const type = typeFor(expression, context);
    accesses.push({
      exprId,
      kind,
      ...(place ? { place } : {}),
      ...(role ? { role } : {}),
      ...(role === "call-argument" &&
      typeof type === "number" &&
      isLoanBearingType(type, typing)
        ? { referenceArgument: true as const }
        : {}),
    });
    if (place && parameterPlaces.has(place.root)) {
      const parameter = parameters[parameterPlaces.get(place.root)!.parameter];
      if (
        parameter?.bindingKind === "mutable-ref" ||
        parameter?.bindingKind === "immutable-ref" ||
        isBorrowedType(parameter?.type, typing)
      ) {
        flags.hasBorrowOperation = true;
      }
    }
  };
  const recordPattern = (
    pattern: HirPattern,
    borrowed = false,
    mutable = false,
  ): void => {
    const annotationType = pattern.typeId;
    const annotatedBorrow =
      borrowed || isBorrowedType(annotationType, typing) ||
      (pattern.bindingKind !== "mutable-ref" &&
        pattern.typeAnnotation?.typeKind === "borrowed");
    if (annotatedBorrow && bindingSymbols(pattern).length > 0) {
      flags.hasBorrowedBinding = true;
    }
    if (pattern.kind === "identifier") {
      if (pattern.bindingKind === "mutable-ref" || mutable) {
        flags.hasMutableBinding = true;
      }
    }
    if (pattern.kind === "tuple") {
      pattern.elements.forEach((entry) =>
        recordPattern(entry, annotatedBorrow, mutable),
      );
    }
    if (pattern.kind === "destructure") {
      pattern.fields.forEach((field) =>
        recordPattern(field.pattern, annotatedBorrow, mutable),
      );
      if (pattern.spread) recordPattern(pattern.spread, annotatedBorrow, mutable);
    }
    if (pattern.kind === "type" && pattern.binding) {
      recordPattern(pattern.binding, annotatedBorrow, mutable);
    }
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

  callable.parameters.forEach((parameter) =>
    recordPattern(parameter.pattern, false, parameter.mutable === true),
  );
  const captureNeedsLoanFlow = (capture: {
    symbol: SymbolId;
    mutable: boolean;
  }): boolean => {
    const type = typing.valueTypes.get(capture.symbol);
    const parameter = parameterPlaces.get(capture.symbol);
    const record = symbolTable.getSymbol(capture.symbol);
    return (
      type !== undefined &&
      (isBorrowedType(type, typing) ||
        typing.arena.get(type).kind === "type-param-ref")
    ) ||
      (capture.mutable === true &&
        record.kind === "value" &&
        !parameter);
  };
  callable.captures?.forEach((capture) => {
    flags.hasCapture ||= captureNeedsLoanFlow(capture);
  });

  const callTargetsFor = (
    expressionId: HirExprId,
  ): readonly SymbolRef[] => {
    const targets = new Map<string, SymbolRef>();
    [
      typing.callTargets.get(expressionId),
      typing.borrowCallTargets.get(expressionId),
    ].forEach((entries) =>
      entries?.forEach((target, key) => {
        targets.set(`${key}:${target.moduleId}:${target.symbol}`, target);
      }),
    );
    const resolved = Array.from(targets.values());
    if (resolved.length > 0) return resolved;
    const expression = hir.expressions.get(expressionId);
    if (expression?.exprKind !== "call") return [];
    const callee = hir.expressions.get(expression.callee);
    if (callee?.exprKind !== "identifier") return [];
    const imported = context.imports.get(callee.symbol);
    if (imported) return [imported];
    return typing.functions.getSignature(callee.symbol)
      ? [{ moduleId: context.moduleId, symbol: callee.symbol }]
      : [];
  };
  const callPlansFor = (
    expressionId: HirExprId,
  ): readonly (readonly CallArgumentPlanEntry[])[] => [
    ...(typing.callArgumentPlans.get(expressionId)?.values() ?? []),
    ...(typing.borrowCallArgumentPlans.get(expressionId)?.values() ?? []),
  ];
  const targetSignatureFor = (
    target: SymbolRef,
  ): Pick<FunctionSignature, "parameters" | "returnType" | "effectRow"> | undefined => {
    if (target.moduleId !== context.moduleId) {
      return context.dependencies.get(target.moduleId)?.callables.get(target.symbol)
        ?.signature;
    }
    const signature = typing.functions.getSignature(target.symbol);
    if (signature) return signature;
    return undefined;
  };
  const targetContractFor = (
    target: SymbolRef,
  ): CallableBorrowContract | undefined =>
    target.moduleId === context.moduleId
      ? context.contracts.get(target.symbol)
      : context.dependencies.get(target.moduleId)?.callables.get(target.symbol)
          ?.contract;
  const targetMaySuspend = (target: SymbolRef): boolean =>
    target.moduleId === context.moduleId
      ? decls.getEffectOperation(target.symbol)?.operation.resumable === "resume" ||
        targetContractFor(target)?.maySuspend === true
      : context.dependencies.get(target.moduleId)?.effectOperations.get(target.symbol)
          ?.maySuspend === true || targetContractFor(target)?.maySuspend === true;
  const targetIsIntrinsic = (target: SymbolRef): boolean => {
    if (target.moduleId !== context.moduleId || target.symbol < 0) return false;
    const metadata = symbolTable.getSymbol(target.symbol).metadata as
      | { intrinsic?: boolean }
      | undefined;
    return metadata?.intrinsic === true;
  };
  const expressionIsFresh = (expressionId: HirExprId, depth = 0): boolean => {
    if (depth > 2) return false;
    const expression = hir.expressions.get(expressionId);
    if (!expression) return false;
    if (expression.exprKind === "object-literal") return true;
    if (expression.exprKind === "block") {
      return typeof expression.value === "number"
        ? expressionIsFresh(expression.value, depth + 1)
        : false;
    }
    if (expression.exprKind !== "call" && expression.exprKind !== "method-call") {
      return false;
    }
    if (expression.exprKind === "call") {
      const intrinsicName = callIntrinsicName(expression, context);
      if (
        intrinsicName === "__array_new" ||
        intrinsicName === "__array_new_fixed"
      ) {
        return true;
      }
    }
    const targets = callTargetsFor(expressionId);
    return (
      targets.length > 0 &&
      targets.every((target) => targetContractFor(target)?.freshResult === true)
    );
  };
  const expressionContainsModuleStorageValue = (
    expressionId: HirExprId,
    depth = 0,
  ): boolean => {
    if (depth > 4) return true;
    const expression = hir.expressions.get(expressionId);
    if (!expression) return true;
    const type = typeFor(expressionId, context);
    if (
      isStoragePlace(placeOfExpression(expressionId, hir, context)) &&
      typeof type === "number" &&
      typeCanCarryReference(type, typing)
    ) {
      return true;
    }
    if (expression.exprKind === "block") {
      return (
        (typeof expression.value === "number" &&
          expressionContainsModuleStorageValue(expression.value, depth + 1)) ||
        expression.statements.some((statementId) => {
          const statement = hir.statements.get(statementId);
          const statementExpression =
            statement?.kind === "expr-stmt"
              ? hir.expressions.get(statement.expr)
              : undefined;
          return (
            (statement?.kind === "return" &&
              typeof statement.value === "number" &&
              expressionContainsModuleStorageValue(statement.value, depth + 1)) ||
            (statement?.kind === "expr-stmt" &&
              (statementExpression?.exprKind === "if" ||
                statementExpression?.exprKind === "cond" ||
                statementExpression?.exprKind === "match" ||
                statementExpression?.exprKind === "block" ||
                statementExpression?.exprKind === "effect-handler") &&
              expressionContainsModuleStorageValue(statement.expr, depth + 1))
          );
        })
      );
    }
    if (expression.exprKind === "tuple") {
      return expression.elements.some((element) =>
        expressionContainsModuleStorageValue(element, depth + 1),
      );
    }
    if (expression.exprKind === "object-literal") {
      return expression.entries.some((entry) =>
        expressionContainsModuleStorageValue(entry.value, depth + 1),
      );
    }
    if (expression.exprKind === "field-access") {
      return expressionContainsModuleStorageValue(expression.target, depth + 1);
    }
    if (
      expression.exprKind === "if" ||
      expression.exprKind === "cond" ||
      expression.exprKind === "match"
    ) {
      const values =
        expression.exprKind === "match"
          ? expression.arms.map((arm) => arm.value)
          : [
              ...expression.branches.map((branch) => branch.value),
              ...(typeof expression.defaultBranch === "number"
                ? [expression.defaultBranch]
                : []),
            ];
      return values.some((value) =>
        expressionContainsModuleStorageValue(value, depth + 1),
      );
    }
    return false;
  };
  const expressionContainsParameterValue = (
    expressionId: HirExprId,
    depth = 0,
  ): boolean => {
    if (depth > 4) return true;
    const expression = hir.expressions.get(expressionId);
    if (!expression) return true;
    if (expression.exprKind === "identifier") {
      const parameter = parameterPlaces.get(expression.symbol);
      if (parameter !== undefined) {
        const parameterType = parameters[parameter.parameter]?.type;
        if (
          typeof parameterType === "number" &&
          typeCanCarryReference(parameterType, typing)
        ) {
          return true;
        }
      }
    }
    const place = placeOfExpression(expressionId, hir, context);
    if (place && parameterPlaces.has(place.root)) {
      const parameterPlace = parameterPlaces.get(place.root);
      const parameter =
        parameterPlace === undefined ? undefined : parameters[parameterPlace.parameter];
      if (
        parameter &&
        typeof parameter.type === "number" &&
        typeCanCarryReference(parameter.type, typing)
      ) {
        return true;
      }
    }
    if (expression.exprKind === "block") {
      return (
        (typeof expression.value === "number" &&
          expressionContainsParameterValue(expression.value, depth + 1)) ||
        expression.statements.some((statementId) => {
          const statement = hir.statements.get(statementId);
          const statementExpression =
            statement?.kind === "expr-stmt"
              ? hir.expressions.get(statement.expr)
              : undefined;
          return (
            (statement?.kind === "return" &&
              typeof statement.value === "number" &&
              expressionContainsParameterValue(statement.value, depth + 1)) ||
            (statement?.kind === "expr-stmt" &&
              (statementExpression?.exprKind === "if" ||
                statementExpression?.exprKind === "cond" ||
                statementExpression?.exprKind === "match" ||
                statementExpression?.exprKind === "block" ||
                statementExpression?.exprKind === "effect-handler") &&
              expressionContainsParameterValue(statement.expr, depth + 1))
          );
        })
      );
    }
    if (expression.exprKind === "tuple") {
      return expression.elements.some((element) =>
        expressionContainsParameterValue(element, depth + 1),
      );
    }
    if (expression.exprKind === "object-literal") {
      return expression.entries.some((entry) =>
        expressionContainsParameterValue(entry.value, depth + 1),
      );
    }
    if (expression.exprKind === "field-access") {
      return expressionContainsParameterValue(expression.target, depth + 1);
    }
    if (
      expression.exprKind === "if" ||
      expression.exprKind === "cond" ||
      expression.exprKind === "match"
    ) {
      const values =
        expression.exprKind === "match"
          ? expression.arms.map((arm) => arm.value)
          : [
              ...expression.branches.map((branch) => branch.value),
              ...(typeof expression.defaultBranch === "number"
                ? [expression.defaultBranch]
                : []),
            ];
      return values.some((value) =>
        expressionContainsParameterValue(value, depth + 1),
      );
    }
    return false;
  };
  const expressionIsSimplePlainParameterReturn = (
    expressionId: HirExprId,
    depth = 0,
  ): boolean => {
    if (depth > 2) return false;
    const expression = hir.expressions.get(expressionId);
    if (!expression) return false;
    if (expression.exprKind === "block") {
      return typeof expression.value === "number"
        ? expressionIsSimplePlainParameterReturn(expression.value, depth + 1)
        : false;
    }
    if (expression.exprKind !== "identifier") return false;
    const place = placeOfExpression(expressionId, hir, context);
    if (!place || place.projections.length > 0) return false;
    const parameter = parameterPlaces.get(place.root);
    return (
      parameter !== undefined &&
      parameters[parameter.parameter]?.access === "owned" &&
      typeof parameters[parameter.parameter]?.type === "number" &&
      typeCanCarryReference(parameters[parameter.parameter]!.type!, typing)
    );
  };
  const expressionHasNonFreshReferenceValue = (
    expressionId: HirExprId,
  ): boolean => {
    const type = typeFor(expressionId, context);
    if (typeof type !== "number" || !typeCanCarryReference(type, typing)) {
      return false;
    }
    return !(
      expressionIsFresh(expressionId) &&
      !expressionContainsParameterValue(expressionId) &&
      !expressionContainsModuleStorageValue(expressionId)
    );
  };
  const typeContainsCallable = (
    type: TypeId | undefined,
    active = new Set<TypeId>(),
  ): boolean => {
    if (typeof type !== "number" || active.has(type)) return false;
    const nextActive = new Set(active).add(type);
    const descriptor = typing.arena.get(type);
    switch (descriptor.kind) {
      case "function":
        return true;
      case "borrowed":
        return typeContainsCallable(descriptor.inner, nextActive);
      case "recursive":
        return typeContainsCallable(descriptor.body, nextActive);
      case "union":
        return descriptor.members.some((member) =>
          typeContainsCallable(member, nextActive),
        );
      case "intersection":
        return (
          (typeof descriptor.nominal === "number" &&
            typeContainsCallable(descriptor.nominal, nextActive)) ||
          (typeof descriptor.structural === "number" &&
            typeContainsCallable(descriptor.structural, nextActive))
        );
      case "value-object":
      case "nominal-object":
      case "structural-object": {
        const fields =
          descriptor.kind === "structural-object"
            ? descriptor.fields
            : typing.objectsByNominal.get(type)?.fields;
        return (
          fields?.some((field) =>
            typeContainsCallable(field.type, nextActive),
          ) ?? false
        );
      }
      case "fixed-array":
        return typeContainsCallable(descriptor.element, nextActive);
      case "type-param-ref":
      case "primitive":
        return false;
    }
    return false;
  };
  const expressionReturnsLoanSensitiveCallable = (
    expressionId: HirExprId,
    depth = 0,
  ): boolean => {
    if (depth > 4) return true;
    const expression = hir.expressions.get(expressionId);
    if (!expression) return true;
    if (expression.exprKind === "lambda") {
      return expression.captures.some((capture) => {
        const captureType = typing.valueTypes.get(capture.symbol);
        const captureRecord = symbolTable.getSymbol(capture.symbol);
        return (
          isLoanBearingType(captureType, typing) ||
          (capture.mutable && captureRecord.kind === "value")
        );
      });
    }
    if (expression.exprKind === "identifier") {
      return typeContainsCallable(typeFor(expressionId, context));
    }
    if (expression.exprKind === "block") {
      return typeof expression.value === "number"
        ? expressionReturnsLoanSensitiveCallable(expression.value, depth + 1)
        : false;
    }
    if (expression.exprKind === "tuple") {
      return expression.elements.some((element) =>
        expressionReturnsLoanSensitiveCallable(element, depth + 1),
      );
    }
    if (expression.exprKind === "object-literal") {
      return expression.entries.some((entry) =>
        expressionReturnsLoanSensitiveCallable(entry.value, depth + 1),
      );
    }
    if (
      expression.exprKind === "if" ||
      expression.exprKind === "cond" ||
      expression.exprKind === "match"
    ) {
      const values =
        expression.exprKind === "match"
          ? expression.arms.map((arm) => arm.value)
          : [
              ...expression.branches.map((branch) => branch.value),
              ...(typeof expression.defaultBranch === "number"
                ? [expression.defaultBranch]
                : []),
            ];
      return values.some((value) =>
        expressionReturnsLoanSensitiveCallable(value, depth + 1),
      );
    }
    if (
      expression.exprKind === "call" ||
      expression.exprKind === "method-call" ||
      expression.exprKind === "field-access"
    ) {
      if (
        expression.exprKind === "call" ||
        expression.exprKind === "method-call"
      ) {
        const operands = [
          ...(expression.exprKind === "method-call"
            ? [expression.target]
            : []),
          ...expression.args.map((argument) => argument.expr),
        ];
        if (
          operands.some((operand) =>
            expressionContainsParameterValue(operand, depth + 1),
          )
        ) {
          return true;
        }
      }
      return typeContainsCallable(typeFor(expressionId, context));
    }
    return false;
  };

  const resultUseFor = ({
    expressionId,
    returnsBorrowed,
    statement,
    parentId,
    tailPosition,
  }: {
    expressionId: HirExprId;
    returnsBorrowed: boolean;
    statement?: {
      kind: "let" | "expr-stmt" | "return";
      pattern?: HirPattern;
      initializer?: HirExprId;
      expr?: HirExprId;
    };
    parentId?: HirExprId;
    tailPosition: boolean;
  }): CallableBorrowIndexCall["resultUse"] => {
    const resultType = typeFor(expressionId, context);
    const resultIsBorrowed =
      returnsBorrowed || isLoanBearingType(resultType, typing);
    const resultIsKnown =
      typeof resultType === "number" &&
      !typing.arena.containsTypeParams(resultType);
    if (statement?.kind === "return" || tailPosition) {
      return resultIsBorrowed || !resultIsKnown
        ? "escapes-or-ambiguous"
        : "immediate";
    }
    if (statement?.kind === "let" && statement.initializer === expressionId) {
      if (!statement.pattern || bindingSymbols(statement.pattern).length === 0) {
        return "ignored";
      }
      if (resultIsBorrowed) {
        // A named borrowed result may be used later. The cheap index does not
        // prove that use away; it records the conservative escape instead of
        // building an ordering or liveness map.
        flags.hasBorrowedBinding = true;
        flags.hasReferenceBinding = true;
        return "escapes-or-ambiguous";
      }
      // A named result may be used after this expression. The cheap index
      // does not prove that the binding is call-scoped, so keep the bounded
      // result-use classification conservative instead of solving liveness.
      return "escapes-or-ambiguous";
    }
    if (statement?.kind === "expr-stmt" && statement.expr === expressionId) {
      return "ignored";
    }

    const parent =
      parentId === undefined ? undefined : hir.expressions.get(parentId);
    if (parent?.exprKind === "call" || parent?.exprKind === "method-call") {
      const argumentIndex =
        parent.exprKind === "method-call" && parent.target === expressionId
          ? 0
          : (() => {
              const explicitIndex = parent.args.findIndex(
                (argument) => argument.expr === expressionId,
              );
              return explicitIndex < 0
                ? -1
                : explicitIndex + (parent.exprKind === "method-call" ? 1 : 0);
            })();
      if (argumentIndex < 0) return "escapes-or-ambiguous";
      const signatures = callTargetsFor(parent.id)
        .map((target) => targetSignatureFor(target))
        .filter((candidate): candidate is NonNullable<typeof candidate> =>
          candidate !== undefined,
        );
      if (signatures.length === 0) {
        return resultIsBorrowed || !resultIsKnown
          ? "escapes-or-ambiguous"
          : "immediate";
      }
      const hasLoanParameter = signatures.some((signature) => {
        const parameter = signature.parameters[argumentIndex];
        return (
          parameter?.bindingKind === "mutable-ref" ||
          isBorrowedType(parameter?.type, typing)
        );
      });
      return hasLoanParameter || (!resultIsBorrowed && resultIsKnown)
        ? "immediate"
        : "escapes-or-ambiguous";
    }
    if (parent?.exprKind === "assign" && parent.value === expressionId) {
      const targetType =
        typeof parent.target === "number"
          ? typeFor(parent.target, context)
          : undefined;
      return (
        resultIsBorrowed ||
        !resultIsKnown ||
        isBorrowedType(targetType, typing)
      )
        ? "escapes-or-ambiguous"
        : "immediate";
    }
    if (parent !== undefined) {
      return resultIsBorrowed || !resultIsKnown
        ? "escapes-or-ambiguous"
        : "immediate";
    }
    return resultIsBorrowed || !resultIsKnown
      ? "escapes-or-ambiguous"
      : "immediate";
  };

  walkExpression({
    exprId: callable.body,
    hir,
    options: { skipLambdas: true },
    onEnterPattern: (pattern) => recordPattern(pattern),
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind === "let") {
        const type = typeFor(statement.initializer, context);
        const referenceBindingType =
          isBorrowedType(type, typing) ||
          (typeof type === "number" &&
            typing.arena.get(type).kind === "type-param-ref");
        if (
          referenceBindingType &&
          bindingSymbols(statement.pattern).length > 0
        ) {
          flags.hasReferenceBinding = true;
          flags.hasBorrowedBinding = true;
        }
        if (
          (statement.mutable === true ||
            statement.pattern.bindingKind === "mutable-ref") &&
          bindingSymbols(statement.pattern).length > 0 &&
          expressionHasNonFreshReferenceValue(statement.initializer)
        ) {
          // This is a bounded escape trigger, not liveness inference: a
          // mutable handle sourced from a non-fresh value may remain usable
          // after the forming expression. Fresh owned values stay transient.
          flags.hasNonFreshMutableBinding = true;
        }
        recordPattern(
          statement.pattern,
          isBorrowedType(type, typing),
          statement.mutable === true,
        );
      }
      if (statement.kind === "return" && typeof statement.value === "number") {
        flags.hasBorrowedReturn ||= isBorrowedType(
          typeFor(statement.value, context),
          typing,
        );
      }
      if (statement.kind === "return" && typeof statement.value !== "number") {
        return;
      }
    },
    onEnterExpression: (exprId, expression, walkContext) => {
      const currentParentExpression = walkContext.parent;
      const type = typeFor(exprId, context);
      if (isBorrowedType(type, typing)) {
        flags.hasBorrowOperation = true;
      }
      if (expression.exprKind === "identifier") {
        const place = placeOfExpression(exprId, hir, context);
        if (
          place &&
          isStoragePlace(place) &&
          isBorrowedType(type, typing)
        ) {
          flags.hasModuleStorageBorrow = true;
        }
        if (
          place &&
          isStoragePlace(place)
        ) {
          flags.hasModuleStorageAccess = true;
          if (
            (walkContext.tailPosition ||
              (walkContext.statement?.kind === "return" &&
                walkContext.statement.value === exprId)) &&
            typeof type === "number" && typeCanCarryReference(type, typing)
          ) {
            flags.hasModuleStorageBorrow = true;
          }
        }
        return;
      }
      if (expression.exprKind === "lambda") {
        flags.hasCapture ||= expression.captures.some(captureNeedsLoanFlow);
        return;
      }
      if (expression.exprKind === "field-access") {
        recordAccess(exprId, "read", exprId, currentParentExpression);
        const place = placeOfExpression(exprId, hir, context);
        if (
          place &&
          isStoragePlace(place) &&
          (walkContext.tailPosition ||
            (walkContext.statement?.kind === "return" &&
              walkContext.statement.value === exprId)) &&
          typeof type === "number" && typeCanCarryReference(type, typing)
        ) {
          flags.hasModuleStorageBorrow = true;
        }
        return;
      }
      if (expression.exprKind === "assign") {
        if (typeof expression.target === "number") {
          recordAccess(
            exprId,
            "write",
            expression.target,
            exprId,
          );
          const targetPlace = placeOfExpression(expression.target, hir, context);
          const valueType = typeFor(expression.value, context);
          const targetType = typeFor(expression.target, context);
          const targetParameter = targetPlace
            ? parameterPlaces.get(targetPlace.root)
            : undefined;
          const referenceValue = isBorrowCapableType(valueType, typing);
          const valueExpression = hir.expressions.get(expression.value);
          const valueIntrinsic =
            valueExpression?.exprKind === "call"
              ? callIntrinsicName(valueExpression, context)
              : undefined;
          const freshRebinding =
            valueExpression?.exprKind === "object-literal" ||
            valueIntrinsic === "__array_new" ||
            valueIntrinsic === "__array_new_fixed";
          if (
            isBorrowedType(valueType, typing) ||
            isBorrowedType(targetType, typing)
          ) {
            flags.hasBorrowedStore = true;
            if (
              targetPlace &&
              isStoragePlace(targetPlace)
            ) {
              flags.hasModuleStorageBorrow = true;
            }
          }
          if (
            referenceValue &&
            targetParameter?.parameter !== undefined &&
            parameters[targetParameter.parameter]?.bindingKind ===
              "mutable-ref" &&
            (typeof valueType !== "number" ||
              typing.arena.get(valueType).kind !== "function")
          ) {
            if (targetPlace?.projections.length === 0) {
              flags.hasMutableReferenceRebinding = true;
              flags.hasNonFreshMutableReferenceRebinding ||=
                !freshRebinding;
            } else if (!freshRebinding) {
              // Storing a reference-capable non-fresh value through a
              // projected mutable place can retain an alias beyond this
              // operation. The index records only this bounded retention
              // trigger; provenance is still computed by full facts.
              flags.hasRetainedReferenceStore = true;
            }
          }
          if (
            targetPlace &&
            isStoragePlace(targetPlace)
          ) {
            flags.hasModuleStorageAccess = true;
            flags.hasModuleStorageWrite = true;
            if (referenceValue && !freshRebinding) {
              flags.hasRetainedReferenceStore = true;
            }
          }
        }
        return;
      }
      if (expression.exprKind !== "call" && expression.exprKind !== "method-call") {
        return;
      }
      const targets = callTargetsFor(exprId);
      const signatures = targets.flatMap((target) => {
        const signature = targetSignatureFor(target);
        return signature ? [signature] : [];
      });
      const signature = signatures[0];
      const intrinsicName =
        expression.exprKind === "call"
          ? callIntrinsicName(expression, context)
          : undefined;
      const intrinsic = intrinsicName !== undefined;
      const plans = callPlansFor(exprId);
      const planArguments = plans.map((plan) =>
        bindCallArgumentExpressions({
          expression,
          plan,
          parameters: signature?.parameters,
          callerModuleId: context.moduleId,
          hir,
        }),
      );
      const firstPlan = planArguments[0];
      const missingArgumentPlan = plans.length === 0;
      const missingPlanNeedsConservativeFlow =
        missingArgumentPlan &&
        !(
          intrinsicName !== undefined &&
          (BORROW_IRRELEVANT_VALUE_INTRINSICS.has(intrinsicName) ||
            intrinsicName === "~" ||
            intrinsicName === "__shared_cell_value")
        ) &&
        (targets.length === 0 ||
          signatures.length === 0 ||
          signatures.some(
            (candidate) =>
              isLoanBearingType(candidate.returnType, typing) ||
              candidate.parameters.some(
                (parameter) =>
                  parameter.bindingKind === "mutable-ref" ||
                  parameter.bindingKind === "immutable-ref" ||
                  isLoanBearingType(parameter.type, typing),
              ),
          ));
      if (missingArgumentPlan) {
        // The cheap index consumes typing's resolved call view. Missing plans
        // are measured; borrow-relevant gaps are a conservative boundary and
        // full facts will resolve the call if this callable is routed
        // flow-sensitive.
        incrementCompilerPerfCounter("borrowing.index.missingCallPlans");
      }
      const argumentsFromTyping = firstPlan ?? [];
      const unresolvedDefaultPlan =
        plans[0]?.some(
          (entry, parameter) =>
            entry.kind === "omitted-default" &&
            argumentsFromTyping[parameter] === undefined,
        ) ?? false;
      const argumentPlanAmbiguous =
        missingPlanNeedsConservativeFlow ||
        unresolvedDefaultPlan ||
        (planArguments.length > 1 &&
          planArguments
          .slice(1)
          .some((candidate) =>
            firstPlan === undefined || !sameBoundCallArguments(candidate, firstPlan),
          ));
      const intrinsicIndex =
        (intrinsicName === "__array_get" || intrinsicName === "__array_set") &&
        expression.exprKind === "call"
          ? (() => {
              const indexExpression = hir.expressions.get(
                expression.args[1]?.expr ?? -1,
              );
              const constant =
                indexExpression?.exprKind === "literal" &&
                indexExpression.literalKind === "i32"
                  ? Number(indexExpression.value)
                  : undefined;
              return {
                kind: "index" as const,
                stable: constant !== undefined,
                ...(constant !== undefined ? { constant } : {}),
              };
            })()
          : undefined;
      const intrinsicBoundary =
        intrinsic && targets.length > 0 && targets.every(targetIsIntrinsic);
      const traitDispatch = typing.callTraitDispatches.has(exprId);
      const symbolicTraitDispatch =
        expression.exprKind === "method-call" &&
        typing.borrowCallTargets.has(exprId) &&
        !typing.callTargets.has(exprId);
      const traitDefaultDispatch = targets.some(
        (target) =>
          target.moduleId === context.moduleId &&
          traitMethodSymbols.has(target.symbol),
      );
      // The cheap index has no devirtualization proof. A trait-dispatch bit is
      // therefore an open boundary even when the current target set happens
      // to contain concrete implementations.
      const openTraitDispatch =
        traitDispatch || symbolicTraitDispatch || traitDefaultDispatch;
      const arguments_: CallableBorrowIndexArgument[] = argumentsFromTyping.map((argument, parameter) => ({
        parameter,
        ...(plans[0]?.[parameter]?.kind === "omitted-default"
          ? { defaulted: true as const }
          : {}),
        ...(typeof argument === "number" ? { expression: argument } : {}),
        ...(typeof argument === "number"
          ? (() => {
              const rawPlace = placeOfExpression(argument, hir, context);
              if (!rawPlace) return {};
              return { place: rawPlace };
            })()
          : {}),
        ...(typeof argument === "number"
          ? (() => {
              const argumentType = typeFor(argument, context);
              return typeof argumentType === "number"
                ? {
                    type: argumentType,
                    ...((isLoanBearingType(argumentType, typing) ||
                      signature?.parameters[parameter]?.bindingKind ===
                        "mutable-ref" ||
                      signature?.parameters[parameter]?.bindingKind ===
                        "immutable-ref")
                      ? { loanBearing: true as const }
                      : {}),
                  }
                : {};
            })()
          : {}),
        } satisfies CallableBorrowIndexArgument));
      const returnsBorrowed =
        (signature !== undefined && isBorrowedType(signature.returnType, typing)) ||
        ((intrinsicName === "__shared_cell_value" ||
          intrinsicName === "__array_get" ||
          intrinsicName === "__array_copy") &&
          isBorrowCapableType(typeFor(exprId, context), typing));
      const maySuspend =
        (signature !== undefined && !typing.effects.isEmpty(signature.effectRow)) ||
        targets.some(targetMaySuspend);
      const call = {
        exprId,
        span: expression.span,
        targets,
        arguments: arguments_,
        ...(signature ? { signature } : {}),
        intrinsic,
        intrinsicBoundary,
        ...(intrinsicName ? { intrinsicName } : {}),
        ...(intrinsicIndex ? { intrinsicIndex } : {}),
        formsExplicitBorrow:
          signature?.parameters.some((parameter) => isBorrowedType(parameter.type, typing)) ?? false,
        returnsBorrowed,
        resultUse: resultUseFor({
          expressionId: exprId,
          returnsBorrowed,
          statement: walkContext.statement,
          parentId: currentParentExpression,
          tailPosition: walkContext.tailPosition,
        }),
        maySuspend,
        ...(argumentPlanAmbiguous ? { argumentPlanAmbiguous: true as const } : {}),
        ...(traitDispatch ? { traitDispatch: true as const } : {}),
        ...(openTraitDispatch ? { openTraitDispatch: true as const } : {}),
      } satisfies CallableBorrowIndexCall;
      calls.push(call);
      targets.forEach((target) =>
        directCallEdges.set(`${target.moduleId}:${target.symbol}`, target),
      );
      flags.hasBorrowOperation ||= call.formsExplicitBorrow;
      flags.hasSuspension ||= maySuspend;
      flags.hasOpenDispatch ||= call.openTraitDispatch === true || call.argumentPlanAmbiguous === true;
      flags.hasUnresolvedBehavior ||= targets.length === 0 && !intrinsic;
      flags.hasUnknownBehavior ||= signature === undefined && !intrinsic;
      if (intrinsicName === "~" || intrinsicName === "__shared_cell_value") {
        flags.hasBorrowOperation = true;
      }
      if (
        intrinsicName === "__array_get" ||
        intrinsicName === "__array_set" ||
        intrinsicName === "__array_len" ||
        intrinsicName === "__ref_is_null"
      ) {
        flags.hasBorrowOperation = true;
      }
      if (
        intrinsicName === "__array_get" &&
        call.intrinsicIndex?.stable !== true &&
        typeof typeFor(exprId, context) === "number" &&
        typeCanCarryReference(typeFor(exprId, context)!, typing)
      ) {
        // A dynamic element read may originate from any stored element. Its
        // allocation mapping is a full-facts concern, not a compact path.
        flags.hasUnknownBehavior = true;
      }
      if (
        intrinsicName === "__array_copy" &&
        call.arguments.some(
          (argument) =>
            argument.loanBearing === true ||
            (typeof argument.type === "number" &&
              typeCanCarryReference(argument.type, typing)),
        )
      ) {
        flags.hasRetention = true;
      }
      if (
        intrinsicBoundary &&
        intrinsicName !== undefined &&
        !BORROW_IRRELEVANT_VALUE_INTRINSICS.has(intrinsicName) &&
        !new Set([
          "__array_get",
          "__array_copy",
          "__array_new",
          "__array_new_fixed",
          "__array_set",
          "__array_len",
          "__ref_is_null",
        ]).has(intrinsicName) &&
        intrinsicName !== "~" &&
        intrinsicName !== "__shared_cell_value"
      ) {
        flags.hasUnknownBehavior = true;
      }
      if (intrinsicName === "~") {
        const sourceExpression = expression.args.at(-1)?.expr;
        const sourcePlace =
          typeof sourceExpression === "number"
            ? placeOfExpression(sourceExpression, hir, context)
            : undefined;
        const parameterSource = sourcePlace
          ? parameterPlaces.get(sourcePlace.root)
          : undefined;
        if (
          !parameterSource ||
          parameters[parameterSource.parameter]?.bindingKind !== "mutable-ref"
        ) {
          flags.hasUnsafeBorrowFormation = true;
        }
      }
      if (call.formsExplicitBorrow) {
        const hasUnplacedBorrowArgument = call.signature?.parameters.some(
          (parameter, parameterIndex) =>
            isBorrowedType(parameter.type, typing) &&
            call.arguments[parameterIndex]?.place === undefined,
        );
        if (hasUnplacedBorrowArgument) {
          flags.hasUnsafeBorrowFormation = true;
        }
      }
    },
  });

  const defaultHasBorrowFlow = (parameter: (typeof callable.parameters)[number]): boolean => {
    if (typeof parameter.defaultValue !== "number") return false;
    const defaultExpression = hir.expressions.get(parameter.defaultValue);
    const defaultType = typeFor(parameter.defaultValue, context);
    if (
      typeof defaultType !== "number" ||
      isLoanBearingType(defaultType, typing) ||
      typing.arena.containsTypeParams(defaultType)
    ) {
      return true;
    }
    const defaultPlace = placeOfExpression(
      parameter.defaultValue,
      hir,
      context,
    );
    const sourceParameter = defaultPlace
      ? parameterPlaces.get(defaultPlace.root)
      : undefined;
    if (sourceParameter) {
      return true;
    }
    if (
      defaultPlace &&
      isStoragePlace(defaultPlace) &&
      (parameter.pattern.bindingKind === "mutable-ref" ||
        isLoanBearingType(signature?.returnType, typing) ||
        (typeof signature?.returnType === "number" &&
          typeCanCarryReference(signature.returnType, typing)))
    ) {
      return true;
    }
    if (
      defaultExpression?.exprKind !== "call" &&
      defaultExpression?.exprKind !== "method-call"
    ) {
      return false;
    }
    const targets = callTargetsFor(parameter.defaultValue);
    const signatures = targets.flatMap((target) => {
      const targetSignature = targetSignatureFor(target);
      return targetSignature ? [targetSignature] : [];
    });
    const intrinsicName =
      defaultExpression.exprKind === "call"
        ? callIntrinsicName(defaultExpression, context)
        : undefined;
    const targetHasBorrowInput = signatures.some((targetSignature) =>
      targetSignature.parameters.some(
        (targetParameter) =>
          targetParameter.bindingKind === "mutable-ref" ||
          targetParameter.bindingKind === "immutable-ref" ||
          isLoanBearingType(targetParameter.type, typing),
      ),
    );
    const targetHasBorrowEffect = targets.some((target) => {
      const contract = targetContractFor(target);
      return (
        contract?.parameters.some(
          (targetParameter) =>
            targetParameter.access !== "owned" ||
            (targetParameter.readPaths?.length ?? 0) > 0 ||
            (targetParameter.writePaths?.length ?? 0) > 0 ||
            targetParameter.retained === true,
        ) === true ||
        contract?.externalRead === true ||
        contract?.externalWrite === true ||
        (contract?.externalReturnedOrigins?.length ?? 0) > 0
      );
    });
    return (
      intrinsicName === "~" ||
      intrinsicName === "__shared_cell_value" ||
      targets.length === 0 ||
      signatures.length === 0 ||
      targetHasBorrowInput ||
      targetHasBorrowEffect ||
      signatures.some((targetSignature) =>
        isLoanBearingType(targetSignature.returnType, typing) ||
        typeCanCarryReference(targetSignature.returnType, typing),
      )
    );
  };
  flags.hasDefaultBorrowFlow = callable.parameters.some(defaultHasBorrowFlow);


  const receiverOwner = typing.memberMetadata.get(callable.symbol)?.owner;
  if (typeof receiverOwner === "number") {
    const metadata = symbolTable.getSymbol(receiverOwner).metadata as
      | { intrinsicType?: unknown }
      | undefined;
    flags.hasRuntimeCheckedReceiverWrites =
      metadata?.intrinsicType === STD_INTRINSIC_TYPE.sharedCell;
  }
  const resultType = signature?.returnType;
  if (typeof resultType === "number" && typeContainsBorrowed(resultType, typing)) {
    flags.hasBorrowedReturn = true;
  }
  if (
    typeof resultType === "number" &&
    typeIsAllocationBacked(resultType, typing) &&
    !typeContainsBorrowed(resultType, typing) &&
    expressionIsFresh(callable.body)
  ) {
    flags.hasFreshResult = true;
  }
  if (
    typeof resultType === "number" &&
    typeCanCarryReference(resultType, typing) &&
    expressionContainsParameterValue(callable.body)
  ) {
    flags.hasReturnedParameterValue = true;
    flags.hasSimplePlainReturn =
      !typeContainsBorrowed(resultType, typing) &&
      expressionIsSimplePlainParameterReturn(callable.body);
  }
  if (
    typeof resultType === "number" &&
    typeCanCarryReference(resultType, typing) &&
    expressionContainsModuleStorageValue(callable.body)
  ) {
    flags.hasModuleStorageBorrow = true;
  }
  if (
    typeof resultType === "number" &&
    typeContainsCallable(resultType) &&
    expressionReturnsLoanSensitiveCallable(callable.body)
  ) {
    // A returned callable can retain captures or a callback contract. Only
    // the bounded result shape is inspected here; callable body provenance
    // remains owned by full facts once this boundary is crossed.
    flags.hasCallableResult = true;
  }

  if (flags.hasBorrowedReturn || flags.hasBorrowedStore || flags.hasBorrowedBinding) {
    flags.hasBorrowOperation = true;
  }
  const normalized = normalizeIndex({
    symbol: callable.symbol,
    ...(signature ? { signature } : {}),
    ...(callable.borrowContract ? { declaredContract: callable.borrowContract } : {}),
    parameters,
    parameterPlaces,
    accesses,
    calls,
    directCallEdges: Array.from(directCallEdges.values()),
    flags,
  });
  return normalized;
};

export const parameterPlaceForIndexPlace = (
  index: CallableBorrowIndex,
  place: BorrowPlace | undefined,
): { parameter: number; path: readonly PlaceProjection[] } | undefined => {
  if (!place) return undefined;
  const parameter = index.parameterPlaces.get(place.root);
  return parameter
    ? { parameter: parameter.parameter, path: [...parameter.path, ...place.projections] }
    : undefined;
};

export const indexHasBorrowingFootprint = (
  index: CallableBorrowIndex,
): boolean =>
  index.flags.hasBorrowOperation ||
  index.calls.some((call) => call.targets.length > 0);

export const indexCallArgumentFor = (
  call: CallableBorrowIndexCall,
  parameter: number,
): CallableBorrowIndexArgument | undefined =>
  call.arguments.find((argument) => argument.parameter === parameter);
