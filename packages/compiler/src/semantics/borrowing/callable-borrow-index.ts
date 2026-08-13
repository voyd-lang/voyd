import {
  walkExpression,
  type HirExpression,
  type HirFunction,
  type HirGraph,
  type HirLambdaExpr,
  type HirPattern,
  type HirTraitMethod,
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
import { canonicalSymbolRef } from "../typing/symbol-ref-utils.js";
import { expressionTypeFor, type ResolveContext } from "./call-resolution.js";
import type {
  BorrowAccessMode,
  BorrowPlace,
  PlaceProjection,
} from "./model.js";
import { typeCanCarryReference } from "./reference-bearing.js";
import { typeContainsBorrowed } from "./borrowed-types.js";
import {
  BORROW_IRRELEVANT_VALUE_INTRINSICS,
  COMPACT_BORROW_INTRINSICS,
} from "./call-resolution.js";
import { placeOfExpression } from "./places.js";
import {
  typeHasIntrinsicRole,
  typeHasNominalIdentity,
} from "./intrinsic-type-role.js";

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
  bindingKind?: "value" | "mutable-ref" | "immutable-ref";
  expression?: HirExprId;
  place?: BorrowPlace;
  type?: TypeId;
  loanBearing?: true;
  referenceCapable?: true;
  moduleStorage?: true;
  fresh?: true;
  provenanceFreeFresh?: true;
  /** Caller parameters that may be reachable from this local argument. */
  callerParameterOrigins?: readonly number[];
  /** Caller-local places retained by this argument; never crosses a summary boundary. */
  callerParameterOriginPlaces?: readonly {
    parameter: number;
    path: readonly PlaceProjection[];
  }[];
  /** Exact local cursor created by the compiler-owned std Array iterator factory. */
  compilerArrayIterator?: true;
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
  /** A type-parameter object construction, which performs no callable work. */
  ordinaryMutationFreeConstruction?: true;
  intrinsicName?: string;
  methodName?: string;
  intrinsicIndex?: PlaceProjection;
  formsExplicitBorrow: boolean;
  returnsBorrowed: boolean;
  resultUse: "ignored" | "immediate" | "escapes-or-ambiguous";
  maySuspend: boolean;
  argumentPlanAmbiguous?: true;
  traitDispatch?: true;
  openTraitDispatch?: true;
  /** Exact compiler-owned SharedCell access nested inside a Borrow callback. */
  scopedSharedCellAccess?: true;
  /** Exact std Array cursor step; mutates only the fresh cursor outer object. */
  compilerArrayIteratorNext?: true;
  /** Finite declaration ceiling for a constrained/open trait call. */
  ordinaryDynamicBound?: {
    parameterBindingKinds: readonly (
      | "value"
      | "mutable-ref"
      | "immutable-ref"
      | undefined
    )[];
    ambientObjectAccess: boolean;
    invokesUnknownCallback: boolean;
    maySuspend: boolean;
  };
};

export type CallableBorrowIndexFlags = {
  hasMutableParameter: boolean;
  /** A captured object handle that ordinary mutation treats as ambient state. */
  hasAmbientObjectCapture: boolean;
  hasSuspension: boolean;
  hasModuleStorageAccess: boolean;
  hasDefaultArgument: boolean;
  hasDefaultBorrowFlow: boolean;
  hasRuntimeCheckedReceiverWrites: boolean;
};

export type CallableBorrowIndexParameter = {
  symbol: SymbolId;
  parameter: number;
  bindingKind?: "value" | "mutable-ref" | "immutable-ref";
  type?: TypeId;
  defaulted: boolean;
  access: BorrowAccessMode;
  loanBearing?: true;
  referenceCapable?: true;
};

/**
 * Cheap immutable input shared by the finite ordinary-mutation, scoped-borrow,
 * and runtime-guard checks. It contains no CFG or solver-private state.
 */
export type CallableBorrowIndex = {
  symbol: SymbolId;
  signature?: Pick<
    FunctionSignature,
    "parameters" | "returnType" | "effectRow"
  >;
  parameters: readonly CallableBorrowIndexParameter[];
  parameterPlaces: ReadonlyMap<
    SymbolId,
    { parameter: number; path: readonly PlaceProjection[] }
  >;
  accesses: readonly CallableBorrowIndexAccess[];
  calls: readonly CallableBorrowIndexCall[];
  directCallEdges: readonly SymbolRef[];
  /** Reference-capable ambient values captured by this callable. */
  ambientObjectCaptures: readonly SymbolId[];
  /** Ambient roots accessed directly in this callable body. */
  directAmbientObjectRoots: readonly SymbolId[];
  /** Local place roots whose storage address is taken by `let ~alias`. */
  mutableAliasSourceRoots: ReadonlySet<SymbolId>;
  /** Parameters whose root storage is reassigned, rather than projected. */
  rootReboundParameters: ReadonlySet<number>;
  flags: CallableBorrowIndexFlags;
};

type IndexCallable = Pick<HirFunction, "symbol" | "parameters" | "body"> & {
  type?: TypeId;
  captures?: HirLambdaExpr["captures"];
};

type MutableFlags = {
  -readonly [Key in keyof CallableBorrowIndexFlags]: boolean;
};

const MAX_LOCAL_ALIAS_TRAVERSAL = 4_096;
const MAX_LOCAL_ALIAS_EDGES = 4_096;
const STD_ARRAY_MODULE_ID = "std::array";
const STD_ARRAY_TYPE_NAME = "Array";
const STD_ARRAY_ITERATOR_TYPE_NAME = "ArrayIterator";

const emptyFlags = (): MutableFlags => ({
  hasMutableParameter: false,
  hasAmbientObjectCapture: false,
  hasSuspension: false,
  hasModuleStorageAccess: false,
  hasDefaultArgument: false,
  hasDefaultBorrowFlow: false,
  hasRuntimeCheckedReceiverWrites: false,
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
          visit(element, parameter, [...path, { kind: "tuple", index }]),
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

const patternHasMutableReference = (
  pattern: HirPattern,
  inheritedMutable = false,
): boolean => {
  const mutable = inheritedMutable || pattern.bindingKind === "mutable-ref";
  switch (pattern.kind) {
    case "identifier":
      return mutable;
    case "tuple":
      return pattern.elements.some((entry) =>
        patternHasMutableReference(entry, mutable),
      );
    case "destructure":
      return (
        pattern.fields.some((field) =>
          patternHasMutableReference(field.pattern, mutable),
        ) ||
        (pattern.spread !== undefined &&
          patternHasMutableReference(pattern.spread, mutable))
      );
    case "type":
      return (
        pattern.binding !== undefined &&
        patternHasMutableReference(pattern.binding, mutable)
      );
    case "wildcard":
      return false;
  }
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
    (record.metadata as { moduleLet?: boolean } | undefined)?.moduleLet ===
      true && typing.functions.getSignature(symbol) === undefined
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
  (isBorrowedType(type, typing) ||
    typing.arena.get(type).kind === "type-param-ref");

const isBorrowCapableType = (
  type: TypeId | undefined,
  typing: TypingResult,
): boolean =>
  typeof type === "number" &&
  (typeContainsBorrowed(type, typing) || typeCanCarryReference(type, typing));

const normalizeIndex = (index: CallableBorrowIndex): CallableBorrowIndex => ({
  ...index,
  parameters: [...index.parameters],
  accesses: [...index.accesses],
  calls: [...index.calls],
  directCallEdges: [...index.directCallEdges],
  ambientObjectCaptures: [...index.ambientObjectCaptures],
  directAmbientObjectRoots: [...index.directAmbientObjectRoots],
  mutableAliasSourceRoots: new Set(index.mutableAliasSourceRoots),
  rootReboundParameters: new Set(index.rootReboundParameters),
  flags: { ...index.flags },
});

export const extractCallableBorrowIndex = ({
  callables,
  hir,
  typing,
  symbolTable,
  decls,
  resolveContext,
  resolvedCallTargets,
}: {
  callables: readonly IndexCallable[];
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  decls: DeclTable;
  resolveContext: ResolveContext;
  resolvedCallTargets: ReadonlyMap<HirExprId, readonly SymbolRef[]>;
}): ReadonlyMap<SymbolId, CallableBorrowIndex> => {
  const localTraitMethods = new Map(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "trait"
        ? item.methods.map((method) => [method.symbol, method] as const)
        : [],
    ),
  );
  return new Map(
    callables.map((callable) => [
      callable.symbol,
      extractSingleCallableBorrowIndex({
        callable,
        hir,
        typing,
        symbolTable,
        decls,
        resolveContext,
        resolvedCallTargets,
        localTraitMethods,
      }),
    ]),
  );
};

export const extractSingleCallableBorrowIndex = ({
  callable,
  hir,
  typing,
  symbolTable,
  decls,
  resolveContext,
  resolvedCallTargets,
  localTraitMethods,
}: {
  callable: IndexCallable;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  decls: DeclTable;
  resolveContext: ResolveContext;
  resolvedCallTargets: ReadonlyMap<HirExprId, readonly SymbolRef[]>;
  localTraitMethods: ReadonlyMap<SymbolId, HirTraitMethod>;
}): CallableBorrowIndex => {
  const context: ResolveContext = {
    ...resolveContext,
    hir,
    typing,
    symbolTable,
    decls,
    borrowIndexMode: "symbolic",
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
      ...(typeof type !== "number" || typeCanCarryReference(type, typing)
        ? { referenceCapable: true as const }
        : {}),
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
  flags.hasDefaultArgument = parameters.some(
    (parameter) => parameter.defaulted,
  );
  const accesses: CallableBorrowIndexAccess[] = [];
  const calls: CallableBorrowIndexCall[] = [];
  const callsByExpression = new Map<HirExprId, CallableBorrowIndexCall>();
  const directCallEdges = new Map<string, SymbolRef>();
  const parameterPlaces = parameterPlacesFor(callable.parameters);
  const freshBindingRoots = new Set<SymbolId>();
  const provenanceFreeFreshBindingRoots = new Set<SymbolId>();
  const compilerArrayIteratorRoots = new Set<SymbolId>();
  const localAliasParents = new Map<SymbolId, SymbolId>();
  const localAliasComponentSizes = new Map<SymbolId, number>();
  const localAliasSourceComponents = new Map<SymbolId, Set<SymbolId>>();
  const nonUniqueLocalAliasComponents = new Set<SymbolId>();
  let localAliasEdgeCount = 0;
  let localAliasTrackingTruncated = false;
  const callerParameterOriginsByRoot = new Map<SymbolId, readonly number[]>();
  const mutableAliasSourceRoots = new Set<SymbolId>();
  const rootReboundParameters = new Set<number>();
  const directAmbientObjectRoots = new Set<SymbolId>();
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
  ): CallableBorrowIndexAccess["role"] => roleForChild(parentId, expressionId);
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
  const ambientObjectCaptures =
    callable.captures?.flatMap((capture) => {
      const type = typing.valueTypes.get(capture.symbol);
      return typeof type === "number" &&
        typeCanCarryReference(type, typing) &&
        !typeHasIntrinsicRole({
          type,
          role: STD_INTRINSIC_TYPE.stringSlice,
          typing,
          symbolTable,
          moduleId: context.moduleId,
          imports: context.imports,
        })
        ? [capture.symbol]
        : [];
    }) ?? [];
  const ambientObjectCaptureSet = new Set(ambientObjectCaptures);
  const ambientObjectCaptureUses: {
    root: SymbolId;
    expression: HirExprId;
    parent?: HirExprId;
  }[] = [];

  const callTargetsFor = (expressionId: HirExprId): readonly SymbolRef[] =>
    resolvedCallTargets.get(expressionId) ?? [];
  const callPlansFor = (
    expressionId: HirExprId,
  ): readonly (readonly CallArgumentPlanEntry[])[] => [
    ...(typing.callArgumentPlans.get(expressionId)?.values() ?? []),
    ...(typing.borrowCallArgumentPlans.get(expressionId)?.values() ?? []),
  ];
  const targetSignatureFor = (
    target: SymbolRef,
  ):
    | Pick<FunctionSignature, "parameters" | "returnType" | "effectRow">
    | undefined => {
    if (target.moduleId !== context.moduleId) {
      return context.dependencies
        .get(target.moduleId)
        ?.callables.get(target.symbol)?.signature;
    }
    const signature = typing.functions.getSignature(target.symbol);
    if (signature) return signature;
    return undefined;
  };
  const targetNameFor = (target: SymbolRef): string | undefined =>
    target.moduleId === context.moduleId
      ? symbolTable.hasSymbol(target.symbol)
        ? symbolTable.getSymbol(target.symbol).name
        : undefined
      : context.dependencies.get(target.moduleId)?.callables.get(target.symbol)
          ?.name;
  const isCanonicalStdArrayTarget = (
    target: SymbolRef,
    name: "iter" | "next",
  ): boolean =>
    target.moduleId === STD_ARRAY_MODULE_ID && targetNameFor(target) === name;
  const isCanonicalStdArrayType = (type: TypeId | undefined): boolean =>
    typeHasIntrinsicRole({
      type,
      role: STD_INTRINSIC_TYPE.array,
      typing,
      symbolTable,
      moduleId: context.moduleId,
      imports: context.imports,
    }) &&
    typeHasNominalIdentity({
      type,
      ownerModuleId: STD_ARRAY_MODULE_ID,
      ownerName: STD_ARRAY_TYPE_NAME,
      typing,
    });
  const isCanonicalStdArrayIteratorType = (
    type: TypeId | undefined,
  ): boolean =>
    typeHasNominalIdentity({
      type,
      ownerModuleId: STD_ARRAY_MODULE_ID,
      ownerName: STD_ARRAY_ITERATOR_TYPE_NAME,
      typing,
    });
  const expressionIsCompilerArrayIteratorFactory = (
    expressionId: HirExprId,
  ): boolean => {
    const expression = hir.expressions.get(expressionId);
    if (
      expression?.exprKind !== "method-call" ||
      expression.method !== "iter"
    ) {
      return false;
    }
    const receiverType = typeFor(expression.target, context);
    if (!isCanonicalStdArrayType(receiverType)) return false;
    const targets = callTargetsFor(expressionId);
    const signature = targets.length === 1 ? targetSignatureFor(targets[0]!) : undefined;
    return (
      targets.length === 1 &&
      isCanonicalStdArrayTarget(targets[0]!, "iter") &&
      isCanonicalStdArrayIteratorType(signature?.returnType)
    );
  };
  const targetMaySuspend = (target: SymbolRef): boolean =>
    target.moduleId === context.moduleId
      ? decls.getEffectOperation(target.symbol)?.operation.resumable ===
        "resume"
      : context.dependencies
          .get(target.moduleId)
          ?.effectOperations.get(target.symbol)?.maySuspend === true;
  const traitMethodMaySuspend = (method: HirTraitMethod): boolean => {
    // An omitted trait effect row is open. Only an explicit empty row (`: ()`)
    // promises that every implementation and dynamic dispatch is pure.
    if (!method.effectType) return true;
    const target = canonicalSymbolRef({
      symbol: method.symbol,
      symbolTable,
      moduleId: context.moduleId,
    });
    const signature = targetSignatureFor(target);
    if (signature) return !typing.effects.isEmpty(signature.effectRow);
    return !(
      method.effectType.typeKind === "tuple" &&
      method.effectType.elements.length === 0
    );
  };
  const targetIsIntrinsic = (target: SymbolRef): boolean => {
    if (target.moduleId !== context.moduleId || target.symbol < 0) return false;
    const metadata = symbolTable.getSymbol(target.symbol).metadata as
      | { intrinsic?: boolean }
      | undefined;
    return metadata?.intrinsic === true;
  };
  const constrainedTraitMethodsFor = (
    expression: HirExpression,
  ): readonly HirTraitMethod[] => {
    if (
      expression.exprKind === "call" &&
      typeof expression.staticTraitSymbol === "number"
    ) {
      const methodName =
        expression.staticTraitMethod ??
        (() => {
          const callee = hir.expressions.get(expression.callee);
          return callee?.exprKind === "identifier" &&
            symbolTable.hasSymbol(callee.symbol)
            ? symbolTable.getSymbol(callee.symbol).name
            : undefined;
        })();
      if (!methodName) return [];
      return (
        typing.traits
          .getDecl(expression.staticTraitSymbol)
          ?.methods.filter(
            (method) =>
              symbolTable.hasSymbol(method.symbol) &&
              symbolTable.getSymbol(method.symbol).name === methodName,
          ) ?? []
      );
    }
    if (expression.exprKind !== "method-call") return [];
    const receiverType = typeFor(expression.target, context);
    if (typeof receiverType !== "number") return [];
    const collectTraitTypes = (type: TypeId): readonly TypeId[] => {
      const descriptor = typing.arena.get(typing.arena.unfoldRecursive(type));
      if (descriptor.kind === "type-param-ref") {
        const constraint = typing.typeParameterConstraints.get(
          descriptor.param,
        );
        return typeof constraint === "number"
          ? collectTraitTypes(constraint)
          : [];
      }
      if (descriptor.kind === "trait") return [type];
      if (descriptor.kind === "intersection") {
        return descriptor.traits?.flatMap(collectTraitTypes) ?? [];
      }
      return [];
    };
    return collectTraitTypes(receiverType).flatMap((traitType) => {
      const descriptor = typing.arena.get(
        typing.arena.unfoldRecursive(traitType),
      );
      if (descriptor.kind !== "trait") return [];
      return (
        typing.traits
          .getDecl(descriptor.owner.symbol)
          ?.methods.filter(
            (method) =>
              symbolTable.getSymbol(method.symbol).name === expression.method,
          ) ?? []
      );
    });
  };
  const traitMethodMatchesCallShape = (
    method: HirTraitMethod,
    expression: HirExpression,
  ): boolean => {
    if (expression.exprKind === "method-call") {
      if (method.parameters.length !== expression.args.length + 1) {
        return false;
      }
      return expression.args.every(
        (argument, index) =>
          argument.label === method.parameters[index + 1]?.label,
      );
    }
    if (expression.exprKind !== "call") return false;
    if (method.parameters.length !== expression.args.length) return false;
    return expression.args.every(
      (argument, index) => argument.label === method.parameters[index]?.label,
    );
  };
  const declarationRefForTarget = (
    target: SymbolRef,
  ): SymbolRef | undefined => {
    if (target.moduleId !== context.moduleId) {
      return context.dependencies
        .get(target.moduleId)
        ?.traitMethodDeclarations.get(target.symbol);
    }
    if (localTraitMethods.has(target.symbol)) return target;
    const mapping = typing.traitMethodImpls.get(target.symbol);
    return mapping
      ? canonicalSymbolRef({
          symbol: mapping.traitMethodSymbol,
          symbolTable,
          moduleId: context.moduleId,
        })
      : undefined;
  };
  const selectedConstrainedTraitMethods = ({
    expression,
    candidates,
    targets,
  }: {
    expression: HirExpression;
    candidates: readonly HirTraitMethod[];
    targets: readonly SymbolRef[];
  }): readonly HirTraitMethod[] => {
    const matchingShape = candidates.filter((method) =>
      traitMethodMatchesCallShape(method, expression),
    );
    const shaped = matchingShape.length > 0 ? matchingShape : candidates;
    const declarationKeys = new Set(
      targets.flatMap((target) => {
        const declaration = declarationRefForTarget(target);
        return declaration
          ? [`${declaration.moduleId}:${declaration.symbol}`]
          : [];
      }),
    );
    if (declarationKeys.size === 0) return shaped;
    const exact = shaped.filter((method) => {
      const declaration = canonicalSymbolRef({
        symbol: method.symbol,
        symbolTable,
        moduleId: context.moduleId,
      });
      return declarationKeys.has(
        `${declaration.moduleId}:${declaration.symbol}`,
      );
    });
    return exact;
  };
  const hasOpenTraitReceiver = (expression: HirExpression): boolean => {
    if (expression.exprKind !== "method-call") return false;
    const receiverType = typeFor(expression.target, context);
    if (typeof receiverType !== "number") return false;
    const isOpenTraitType = (type: TypeId): boolean => {
      const descriptor = typing.arena.get(typing.arena.unfoldRecursive(type));
      if (descriptor.kind === "type-param-ref") {
        const constraint = typing.typeParameterConstraints.get(
          descriptor.param,
        );
        return typeof constraint === "number" && isOpenTraitType(constraint);
      }
      if (descriptor.kind === "trait") return true;
      return (
        descriptor.kind === "intersection" &&
        (descriptor.traits?.some(isOpenTraitType) ?? false)
      );
    };
    return isOpenTraitType(receiverType);
  };
  const hasOpenTraitTarget = (
    expressionId: HirExprId,
    targets: readonly SymbolRef[],
  ): boolean =>
    typing.callTraitDispatches.has(expressionId) ||
    targets.some((target) =>
      target.moduleId === context.moduleId
        ? localTraitMethods.has(target.symbol) ||
          context.typing.traitMethodImpls.has(target.symbol)
        : context.dependencies
            .get(target.moduleId)
            ?.traitMethodDeclarations.has(target.symbol) === true,
    );
  const hasTraitDeclarationTarget = (targets: readonly SymbolRef[]): boolean =>
    targets.some((target) => {
      if (target.moduleId === context.moduleId) {
        return localTraitMethods.has(target.symbol);
      }
      const declaration = context.dependencies
        .get(target.moduleId)
        ?.traitMethodDeclarations.get(target.symbol);
      return (
        declaration?.moduleId === target.moduleId &&
        declaration.symbol === target.symbol
      );
    });
  const isTypeParameterObjectConstruction = (
    expression: HirExpression,
  ): boolean => {
    if (expression.exprKind !== "call" || expression.args.length !== 1) {
      return false;
    }
    const callee = hir.expressions.get(expression.callee);
    const initializer = hir.expressions.get(expression.args[0]!.expr);
    return (
      callee?.exprKind === "identifier" &&
      symbolTable.getSymbol(callee.symbol).kind === "type-parameter" &&
      initializer?.exprKind === "object-literal"
    );
  };
  const expressionIsDirectFresh = (expressionId: HirExprId): boolean => {
    const expression = hir.expressions.get(expressionId);
    if (expression?.exprKind === "object-literal") return true;
    const place = placeOfExpression(expressionId, hir, context);
    if (
      place &&
      freshBindingRoots.has(place.root) &&
      localFreshRootIsUnique(place.root) &&
      place.projections.every((projection) => projection.kind === "identity")
    ) {
      return true;
    }
    if (expression?.exprKind === "call") {
      const intrinsicName = callIntrinsicName(expression, context);
      if (
        intrinsicName === "__array_new" ||
        intrinsicName === "__array_new_fixed"
      ) {
        return true;
      }
    }
    return false;
  };
  const expressionIsStableStringSlice = (expressionId: HirExprId): boolean => {
    const type = typeFor(expressionId, context);
    return (
      typeof type === "number" &&
      typeHasIntrinsicRole({
        type,
        role: STD_INTRINSIC_TYPE.stringSlice,
        typing,
        symbolTable,
        moduleId: context.moduleId,
        imports: context.imports,
      })
    );
  };
  const expressionIsProvenanceFreeFresh = (
    expressionId: HirExprId,
  ): boolean => {
    const type = typeFor(expressionId, context);
    if (typeof type !== "number" || !typeCanCarryReference(type, typing)) {
      return true;
    }
    if (expressionIsStableStringSlice(expressionId)) return true;
    const expression = hir.expressions.get(expressionId);
    if (expression?.exprKind === "object-literal") {
      return expression.entries.every((entry) =>
        expressionIsProvenanceFreeFresh(entry.value),
      );
    }
    if (expression?.exprKind !== "call") return false;
    const intrinsicName = callIntrinsicName(expression, context);
    return (
      (intrinsicName === "__array_new" ||
        intrinsicName === "__array_new_fixed") &&
      expression.args.every((argument) =>
        expressionIsProvenanceFreeFresh(argument.expr),
      )
    );
  };
  const localAliasComponentFor = (root: SymbolId): SymbolId => {
    const initialParent = localAliasParents.get(root);
    if (initialParent === undefined) {
      localAliasParents.set(root, root);
      localAliasComponentSizes.set(root, 1);
      return root;
    }
    let component = initialParent;
    while (localAliasParents.get(component) !== component) {
      component = localAliasParents.get(component)!;
    }
    let current = root;
    while (localAliasParents.get(current) !== component) {
      const parent = localAliasParents.get(current)!;
      localAliasParents.set(current, component);
      current = parent;
    }
    return component;
  };
  const truncateLocalAliasTracking = (): void => {
    if (localAliasTrackingTruncated) return;
    localAliasTrackingTruncated = true;
    localAliasSourceComponents.clear();
    localAliasEdgeCount = 0;
  };
  const mergeLocalAliasComponents = (
    left: SymbolId,
    right: SymbolId,
  ): SymbolId => {
    let parent = localAliasComponentFor(left);
    let child = localAliasComponentFor(right);
    if (parent === child) return parent;
    if (
      (localAliasComponentSizes.get(parent) ?? 1) <
      (localAliasComponentSizes.get(child) ?? 1)
    ) {
      [parent, child] = [child, parent];
    }
    localAliasParents.set(child, parent);
    localAliasComponentSizes.set(
      parent,
      (localAliasComponentSizes.get(parent) ?? 1) +
        (localAliasComponentSizes.get(child) ?? 1),
    );
    localAliasComponentSizes.delete(child);
    if (nonUniqueLocalAliasComponents.delete(child)) {
      nonUniqueLocalAliasComponents.add(parent);
    }
    if (localAliasTrackingTruncated) return parent;
    const parentSources = localAliasSourceComponents.get(parent);
    const childSources = localAliasSourceComponents.get(child);
    localAliasEdgeCount -=
      (parentSources?.size ?? 0) + (childSources?.size ?? 0);
    localAliasSourceComponents.delete(child);
    const mergedSources = new Set<SymbolId>();
    parentSources?.forEach((source) => {
      const component = localAliasComponentFor(source);
      if (component !== parent) mergedSources.add(component);
    });
    childSources?.forEach((source) => {
      const component = localAliasComponentFor(source);
      if (component !== parent) mergedSources.add(component);
    });
    if (mergedSources.size > 0) {
      localAliasSourceComponents.set(parent, mergedSources);
      localAliasEdgeCount += mergedSources.size;
    } else {
      localAliasSourceComponents.delete(parent);
    }
    if (localAliasEdgeCount > MAX_LOCAL_ALIAS_EDGES) {
      truncateLocalAliasTracking();
    }
    return parent;
  };
  const recordLocalAliasSource = (alias: SymbolId, source: SymbolId): void => {
    if (localAliasTrackingTruncated) return;
    const aliasComponent = localAliasComponentFor(alias);
    const sourceComponent = localAliasComponentFor(source);
    if (aliasComponent === sourceComponent) return;
    const recordedSources =
      localAliasSourceComponents.get(aliasComponent) ?? new Set<SymbolId>();
    if (recordedSources.has(sourceComponent)) return;
    if (localAliasEdgeCount >= MAX_LOCAL_ALIAS_EDGES) {
      truncateLocalAliasTracking();
      return;
    }
    recordedSources.add(sourceComponent);
    localAliasSourceComponents.set(aliasComponent, recordedSources);
    localAliasEdgeCount += 1;
  };
  const localAliasComponentsFor = (
    roots: Iterable<SymbolId>,
  ): ReadonlySet<SymbolId> => {
    const result = new Set<SymbolId>();
    const pending = Array.from(roots, localAliasComponentFor);
    while (pending.length > 0 && result.size < MAX_LOCAL_ALIAS_TRAVERSAL) {
      const component = localAliasComponentFor(pending.pop()!);
      if (result.has(component)) continue;
      result.add(component);
      localAliasSourceComponents
        .get(component)
        ?.forEach((source) => pending.push(source));
    }
    if (pending.length > 0) {
      truncateLocalAliasTracking();
    }
    return result;
  };
  const markLocalAliasComponentsNonUnique = (
    components: Iterable<SymbolId>,
  ): void => {
    if (localAliasTrackingTruncated) return;
    for (const component of components) {
      nonUniqueLocalAliasComponents.add(localAliasComponentFor(component));
    }
  };
  const markLocalAliasRootsNonUnique = (roots: Iterable<SymbolId>): void => {
    markLocalAliasComponentsNonUnique(localAliasComponentsFor(roots));
  };
  const localFreshRootIsUnique = (root: SymbolId): boolean =>
    !localAliasTrackingTruncated &&
    !nonUniqueLocalAliasComponents.has(localAliasComponentFor(root));
  const recordLocalAliases = ({
    aliases,
    sources,
    aliasesShareIdentity,
  }: {
    aliases: Iterable<SymbolId>;
    sources: Iterable<SymbolId>;
    aliasesShareIdentity: boolean;
  }): void => {
    const sourceComponents = new Set(
      Array.from(sources, localAliasComponentFor),
    );
    const aliasRoots = Array.from(aliases);
    if (aliasesShareIdentity) {
      aliasRoots.forEach((alias) =>
        sourceComponents.forEach((source) =>
          mergeLocalAliasComponents(alias, source),
        ),
      );
      markLocalAliasRootsNonUnique(aliasRoots);
      return;
    }
    aliasRoots.forEach((alias) =>
      sourceComponents.forEach((source) =>
        recordLocalAliasSource(alias, source),
      ),
    );
    markLocalAliasComponentsNonUnique(sourceComponents);
  };
  const referenceSourceRootsForExpression = (
    expressionId: HirExprId,
  ): ReadonlySet<SymbolId> => {
    const result = new Set<SymbolId>();
    const visited = new Set<HirExprId>();
    let remaining = MAX_LOCAL_ALIAS_TRAVERSAL;
    let truncated = false;
    const addRoot = (root: SymbolId): void => {
      localAliasComponentsFor([root]).forEach((candidate) =>
        result.add(candidate),
      );
    };
    const visit = (candidateId: HirExprId): void => {
      if (visited.has(candidateId)) return;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      remaining -= 1;
      visited.add(candidateId);
      const candidateType = typeFor(candidateId, context);
      if (
        typeof candidateType === "number" &&
        !typeCanCarryReference(candidateType, typing)
      ) {
        return;
      }
      const place = placeOfExpression(candidateId, hir, context);
      if (place) {
        addRoot(place.root);
        return;
      }
      const candidate = hir.expressions.get(candidateId);
      if (!candidate) return;
      switch (candidate.exprKind) {
        case "literal":
        case "identifier":
        case "overload-set":
        case "continue":
          return;
        case "call":
        case "method-call": {
          const call = callsByExpression.get(candidateId);
          const argumentExpressions = call
            ? call.arguments.flatMap((argument) =>
                typeof argument.expression === "number"
                  ? [argument.expression]
                  : [],
              )
            : candidate.args.map((argument) => argument.expr);
          argumentExpressions.forEach(visit);
          if (candidate.exprKind === "method-call") visit(candidate.target);
          if (candidate.exprKind === "call") {
            const callee = hir.expressions.get(candidate.callee);
            if (callee?.exprKind !== "identifier") visit(candidate.callee);
          }
          return;
        }
        case "block":
          if (typeof candidate.value === "number") visit(candidate.value);
          return;
        case "tuple":
          candidate.elements.forEach(visit);
          return;
        case "loop":
          visit(candidate.body);
          return;
        case "while":
          visit(candidate.body);
          return;
        case "if":
        case "cond":
          candidate.branches.forEach((branch) => visit(branch.value));
          if (typeof candidate.defaultBranch === "number") {
            visit(candidate.defaultBranch);
          }
          return;
        case "match":
          // A match pattern may bind a handle from the discriminant before an
          // arm returns it. Include the discriminant as the bounded local
          // fallback instead of publishing pattern provenance.
          visit(candidate.discriminant);
          candidate.arms.forEach((arm) => visit(arm.value));
          return;
        case "lambda":
          candidate.captures.forEach((capture) => {
            const captureType = typing.valueTypes.get(capture.symbol);
            if (
              typeof captureType !== "number" ||
              typeCanCarryReference(captureType, typing)
            ) {
              addRoot(capture.symbol);
            }
          });
          return;
        case "effect-handler":
          visit(candidate.body);
          candidate.handlers.forEach((handler) => visit(handler.body));
          if (typeof candidate.finallyBranch === "number") {
            visit(candidate.finallyBranch);
          }
          return;
        case "object-literal":
          candidate.entries.forEach((entry) => visit(entry.value));
          return;
        case "field-access":
          visit(candidate.target);
          return;
        case "assign":
          visit(candidate.value);
          return;
        case "break":
          if (typeof candidate.value === "number") visit(candidate.value);
          return;
      }
    };
    visit(expressionId);
    if (truncated) {
      truncateLocalAliasTracking();
    }
    return result;
  };
  const expressionSharesReferenceIdentity = (
    expressionId: HirExprId,
    active = new Set<HirExprId>(),
  ): boolean => {
    if (active.has(expressionId)) return true;
    if (placeOfExpression(expressionId, hir, context)) return true;
    const expression = hir.expressions.get(expressionId);
    if (!expression) return true;
    const nextActive = new Set(active).add(expressionId);
    switch (expression.exprKind) {
      case "literal":
      case "overload-set":
      case "continue":
      case "object-literal":
      case "tuple":
      case "lambda":
        return false;
      case "block":
        return typeof expression.value === "number"
          ? expressionSharesReferenceIdentity(expression.value, nextActive)
          : false;
      case "break":
        return typeof expression.value === "number"
          ? expressionSharesReferenceIdentity(expression.value, nextActive)
          : false;
      case "call":
      case "method-call":
      case "loop":
      case "while":
      case "if":
      case "cond":
      case "match":
      case "effect-handler":
      case "field-access":
      case "assign":
      case "identifier":
        return true;
    }
  };
  const callArgumentHasExactScopedUse = (
    call: CallableBorrowIndexCall,
    argument: CallableBorrowIndexArgument,
  ): boolean => {
    if (
      call.argumentPlanAmbiguous === true ||
      call.openTraitDispatch === true ||
      call.traitDispatch === true ||
      call.targets.length !== 1
    ) {
      return false;
    }
    const parameter = call.signature?.parameters[argument.parameter];
    return (
      argument.bindingKind === "mutable-ref" ||
      argument.bindingKind === "immutable-ref" ||
      (typeof parameter?.type === "number" &&
        isBorrowedType(parameter.type, typing))
    );
  };
  const callIsExactPureIntrinsicRead = (
    call: CallableBorrowIndexCall,
  ): boolean =>
    call.intrinsicBoundary &&
    call.intrinsicName !== undefined &&
    (BORROW_IRRELEVANT_VALUE_INTRINSICS.has(call.intrinsicName) ||
      call.intrinsicName === "__array_len" ||
      call.intrinsicName === "__ref_is_null");
  const invalidateRetainableCallArguments = (
    call: CallableBorrowIndexCall,
  ): void => {
    if (callIsExactPureIntrinsicRead(call)) return;
    call.arguments.forEach((argument) => {
      if (
        typeof argument.expression !== "number" ||
        callArgumentHasExactScopedUse(call, argument)
      ) {
        return;
      }
      markLocalAliasComponentsNonUnique(
        referenceSourceRootsForExpression(argument.expression),
      );
    });
  };
  const allReferenceParameterOrigins = parameters.flatMap((parameter) =>
    parameter.referenceCapable === true ? [parameter.parameter] : [],
  );
  const callerParameterOriginsForPlace = (
    place: BorrowPlace,
  ): readonly number[] => {
    const parameter = parameterPlaces.get(place.root);
    if (parameter) return [parameter.parameter];
    const local = callerParameterOriginsByRoot.get(place.root);
    if (local) return local;
    if (isStoragePlace(place)) return [];
    return allReferenceParameterOrigins;
  };
  const mergeCallerParameterOrigins = (
    target: SymbolId,
    origins: readonly number[],
  ): boolean => {
    if (origins.length === 0) return false;
    const current = callerParameterOriginsByRoot.get(target) ?? [];
    const merged = Array.from(new Set([...current, ...origins]));
    if (merged.length === current.length) return false;
    callerParameterOriginsByRoot.set(target, merged);
    return true;
  };
  const callerParameterOriginTransfers: {
    targets: readonly SymbolId[];
    expression: HirExprId;
  }[] = [];
  const callerParameterOriginsForExpression = (
    expressionId: HirExprId,
    active = new Set<HirExprId>(),
  ): readonly number[] => {
    if (active.has(expressionId)) return allReferenceParameterOrigins;
    const expressionType = typeFor(expressionId, context);
    if (
      typeof expressionType === "number" &&
      !typeCanCarryReference(expressionType, typing)
    ) {
      return [];
    }
    if (expressionIsStableStringSlice(expressionId)) return [];
    const place = placeOfExpression(expressionId, hir, context);
    if (place) return callerParameterOriginsForPlace(place);
    const expression = hir.expressions.get(expressionId);
    if (!expression) return allReferenceParameterOrigins;
    const nextActive = new Set(active).add(expressionId);
    if (expression.exprKind === "object-literal") {
      return Array.from(
        new Set(
          expression.entries.flatMap((entry) =>
            callerParameterOriginsForExpression(entry.value, nextActive),
          ),
        ),
      );
    }
    if (expression.exprKind === "tuple") {
      return Array.from(
        new Set(
          expression.elements.flatMap((element) =>
            callerParameterOriginsForExpression(element, nextActive),
          ),
        ),
      );
    }
    if (
      expression.exprKind === "call" ||
      expression.exprKind === "method-call"
    ) {
      const call = callsByExpression.get(expressionId);
      if (!call) return allReferenceParameterOrigins;
      return Array.from(
        new Set(
          call.arguments.flatMap((argument) => {
            if (argument.referenceCapable !== true) return [];
            return typeof argument.expression === "number"
              ? callerParameterOriginsForExpression(
                  argument.expression,
                  nextActive,
                )
              : allReferenceParameterOrigins;
          }),
        ),
      );
    }
    return expressionIsProvenanceFreeFresh(expressionId)
      ? []
      : allReferenceParameterOrigins;
  };
  const callerParameterOriginPlacesForExpression = (
    expressionId: HirExprId,
    active = new Set<HirExprId>(),
  ): readonly { parameter: number; path: readonly PlaceProjection[] }[] => {
    if (active.has(expressionId)) {
      return allReferenceParameterOrigins.map((parameter) => ({
        parameter,
        path: [],
      }));
    }
    const expressionType = typeFor(expressionId, context);
    if (
      typeof expressionType === "number" &&
      !typeCanCarryReference(expressionType, typing)
    ) {
      return [];
    }
    if (expressionIsStableStringSlice(expressionId)) return [];
    const place = placeOfExpression(expressionId, hir, context);
    if (place) {
      const parameter = parameterPlaces.get(place.root);
      if (parameter) {
        return [
          {
            parameter: parameter.parameter,
            path: [...parameter.path, ...place.projections],
          },
        ];
      }
      return (callerParameterOriginsByRoot.get(place.root) ?? []).map(
        (origin) => ({ parameter: origin, path: [] }),
      );
    }
    const expression = hir.expressions.get(expressionId);
    if (!expression) {
      return allReferenceParameterOrigins.map((parameter) => ({
        parameter,
        path: [],
      }));
    }
    const nextActive = new Set(active).add(expressionId);
    const children =
      expression.exprKind === "object-literal"
        ? expression.entries.map((entry) => entry.value)
        : expression.exprKind === "tuple"
          ? expression.elements
          : [];
    if (children.length > 0) {
      return children.flatMap((child) =>
        callerParameterOriginPlacesForExpression(child, nextActive),
      );
    }
    if (
      expression.exprKind === "call" ||
      expression.exprKind === "method-call"
    ) {
      const call = callsByExpression.get(expressionId);
      if (!call) {
        return allReferenceParameterOrigins.map((parameter) => ({
          parameter,
          path: [],
        }));
      }
      return call.arguments.flatMap((argument) =>
        argument.referenceCapable === true &&
        typeof argument.expression === "number"
          ? callerParameterOriginPlacesForExpression(
              argument.expression,
              nextActive,
            )
          : [],
      );
    }
    return expressionIsProvenanceFreeFresh(expressionId)
      ? []
      : allReferenceParameterOrigins.map((parameter) => ({
          parameter,
          path: [],
        }));
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
    const resultCanCarryReference =
      resultIsBorrowed ||
      (typeof resultType === "number" &&
        typeCanCarryReference(resultType, typing));
    const resultIsKnown =
      typeof resultType === "number" &&
      !typing.arena.containsTypeParams(resultType);
    if (statement?.kind === "return" || tailPosition) {
      return resultCanCarryReference || !resultIsKnown
        ? "escapes-or-ambiguous"
        : "immediate";
    }
    if (statement?.kind === "let" && statement.initializer === expressionId) {
      if (
        !statement.pattern ||
        bindingSymbols(statement.pattern).length === 0
      ) {
        return "ignored";
      }
      return "escapes-or-ambiguous";
    }
    if (statement?.kind === "expr-stmt" && statement.expr === expressionId) {
      return "ignored";
    }
    const parent =
      parentId === undefined ? undefined : hir.expressions.get(parentId);
    if (parent?.exprKind === "call" || parent?.exprKind === "method-call") {
      const isOperand =
        (parent.exprKind === "method-call" && parent.target === expressionId) ||
        parent.args.some((argument) => argument.expr === expressionId);
      return isOperand ? "immediate" : "escapes-or-ambiguous";
    }
    if (parent?.exprKind === "assign" && parent.value === expressionId) {
      const targetType =
        typeof parent.target === "number"
          ? typeFor(parent.target, context)
          : undefined;
      return resultIsBorrowed ||
        !resultIsKnown ||
        isBorrowedType(targetType, typing)
        ? "escapes-or-ambiguous"
        : "immediate";
    }
    if (parent !== undefined) {
      return resultCanCarryReference || !resultIsKnown
        ? "escapes-or-ambiguous"
        : "immediate";
    }
    return resultCanCarryReference || !resultIsKnown
      ? "escapes-or-ambiguous"
      : "immediate";
  };

  walkExpression({
    exprId: callable.body,
    hir,
    options: { skipLambdas: true },
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind === "let") {
        callerParameterOriginTransfers.push({
          targets: bindingSymbols(statement.pattern),
          expression: statement.initializer,
        });
        const initializerType = typeFor(statement.initializer, context);
        const initializerPlace = placeOfExpression(
          statement.initializer,
          hir,
          context,
        );
        if (
          initializerPlace &&
          typeof initializerType === "number" &&
          typeCanCarryReference(initializerType, typing)
        ) {
          markLocalAliasRootsNonUnique([
            initializerPlace.root,
            ...bindingSymbols(statement.pattern),
          ]);
        }
        if (patternHasMutableReference(statement.pattern)) {
          const source = placeOfExpression(statement.initializer, hir, context);
          if (source) mutableAliasSourceRoots.add(source.root);
        }
        if (
          statement.mutable !== true &&
          statement.pattern.kind === "identifier" &&
          expressionIsDirectFresh(statement.initializer)
        ) {
          freshBindingRoots.add(statement.pattern.symbol);
          if (expressionIsProvenanceFreeFresh(statement.initializer)) {
            provenanceFreeFreshBindingRoots.add(statement.pattern.symbol);
          }
        }
        if (
          statement.pattern.kind === "identifier" &&
          expressionIsCompilerArrayIteratorFactory(statement.initializer)
        ) {
          compilerArrayIteratorRoots.add(statement.pattern.symbol);
        }
      }
    },
    onEnterExpression: (exprId, expression, walkContext) => {
      const currentParentExpression = walkContext.parent;
      if (expression.exprKind === "identifier") {
        const place = placeOfExpression(exprId, hir, context);
        if (place && ambientObjectCaptureSet.has(place.root)) {
          ambientObjectCaptureUses.push({
            root: place.root,
            expression: exprId,
            ...(typeof currentParentExpression === "number"
              ? { parent: currentParentExpression }
              : {}),
          });
        }
        if (place && isStoragePlace(place)) {
          flags.hasModuleStorageAccess = true;
          directAmbientObjectRoots.add(place.root);
        }
        return;
      }
      if (expression.exprKind === "lambda") return;
      if (expression.exprKind === "field-access") {
        recordAccess(exprId, "read", exprId, currentParentExpression);
        return;
      }
      if (expression.exprKind === "assign") {
        if (typeof expression.target === "number") {
          recordAccess(exprId, "write", expression.target, exprId);
          const targetPlace = placeOfExpression(
            expression.target,
            hir,
            context,
          );
          if (targetPlace && isStoragePlace(targetPlace)) {
            flags.hasModuleStorageAccess = true;
            directAmbientObjectRoots.add(targetPlace.root);
          }
        }
        return;
      }
      if (
        expression.exprKind !== "call" &&
        expression.exprKind !== "method-call"
      ) {
        return;
      }
      const constrainedTraitMethodCandidates =
        constrainedTraitMethodsFor(expression);
      const openTraitReceiver = hasOpenTraitReceiver(expression);
      const resolvedTargets = callTargetsFor(exprId);
      const constrainedTraitMethods = selectedConstrainedTraitMethods({
        expression,
        candidates: constrainedTraitMethodCandidates,
        targets: resolvedTargets,
      });
      const constrainedDeclarationKeys = new Set(
        constrainedTraitMethods.map((method) => {
          const declaration = canonicalSymbolRef({
            symbol: method.symbol,
            symbolTable,
            moduleId: context.moduleId,
          });
          return `${declaration.moduleId}:${declaration.symbol}`;
        }),
      );
      const selectedResolvedTargets = resolvedTargets.filter((target) => {
        const declaration = declarationRefForTarget(target);
        return (
          declaration !== undefined &&
          constrainedDeclarationKeys.has(
            `${declaration.moduleId}:${declaration.symbol}`,
          )
        );
      });
      const targets =
        resolvedTargets.length > 0
          ? selectedResolvedTargets.length > 0
            ? selectedResolvedTargets
            : resolvedTargets
          : constrainedTraitMethods.map((method) =>
              canonicalSymbolRef({
                symbol: method.symbol,
                symbolTable,
                moduleId: context.moduleId,
              }),
            );
      const signatures = targets.flatMap((target) => {
        const signature = targetSignatureFor(target);
        return signature ? [signature] : [];
      });
      const traitDispatch = typing.callTraitDispatches.has(exprId);
      const symbolicTraitDispatch =
        expression.exprKind === "method-call" &&
        typing.borrowCallTargets.has(exprId) &&
        !typing.callTargets.has(exprId);
      const hasOpenTraitCallTarget = hasOpenTraitTarget(exprId, targets);
      const openTraitDispatch =
        traitDispatch ||
        (symbolicTraitDispatch && hasOpenTraitCallTarget) ||
        hasTraitDeclarationTarget(targets) ||
        constrainedTraitMethodCandidates.length > 0 ||
        openTraitReceiver;
      const signature = signatures[0];
      const intrinsicName =
        expression.exprKind === "call"
          ? callIntrinsicName(expression, context)
          : undefined;
      const intrinsic = intrinsicName !== undefined;
      const ordinaryMutationFreeConstruction =
        isTypeParameterObjectConstruction(expression);
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
            COMPACT_BORROW_INTRINSICS.has(intrinsicName))
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
      const targetTraitMethods = targets.flatMap((target) => {
        const declaration = declarationRefForTarget(target);
        if (!declaration || declaration.moduleId !== context.moduleId)
          return [];
        const method = localTraitMethods.get(declaration.symbol);
        return method ? [method] : [];
      });
      const declarationTraitMethods = Array.from(
        new Map(
          [...constrainedTraitMethods, ...targetTraitMethods].map((method) => [
            method.symbol,
            method,
          ]),
        ).values(),
      );
      const constrainedParameters =
        declarationTraitMethods[0]?.parameters ??
        (openTraitReceiver ? signature?.parameters : undefined);
      const dynamicBoundMaySuspend =
        declarationTraitMethods.some(traitMethodMaySuspend) ||
        (openTraitDispatch &&
          signature !== undefined &&
          !typing.effects.isEmpty(signature.effectRow));
      const dynamicBoundParameters =
        constrainedParameters ??
        (openTraitDispatch ? signature?.parameters : undefined);
      const ordinaryDynamicBound =
        declarationTraitMethods.length > 0
          ? ordinaryDynamicBoundForTraitMethods(
              declarationTraitMethods,
              traitMethodMaySuspend,
              (method) => {
                if (!method.effectType) return true;
                const target = canonicalSymbolRef({
                  symbol: method.symbol,
                  symbolTable,
                  moduleId: context.moduleId,
                });
                const signature = targetSignatureFor(target);
                if (signature) {
                  return typing.effects.isOpen(signature.effectRow);
                }
                return (
                  method.effectType.typeKind === "named" &&
                  method.effectType.path.length === 1 &&
                  method.effectType.path[0] === "open"
                );
              },
            )
          : dynamicBoundParameters
            ? ordinaryDynamicBoundForParameters(
                dynamicBoundParameters,
                dynamicBoundMaySuspend,
              )
            : undefined;
      const argumentsFromTyping =
        firstPlan ??
        (constrainedParameters
          ? bindCallArgumentExpressions({
              expression,
              parameters: constrainedParameters,
              callerModuleId: context.moduleId,
              hir,
            })
          : undefined) ??
        (intrinsicName !== undefined &&
        COMPACT_BORROW_INTRINSICS.has(intrinsicName) &&
        expression.exprKind === "call"
          ? expression.args.map((argument) => argument.expr)
          : []);
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
            .some(
              (candidate) =>
                firstPlan === undefined ||
                !sameBoundCallArguments(candidate, firstPlan),
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
      // The cheap index has no devirtualization proof. A trait-dispatch bit is
      // therefore an open boundary even when the current target set happens
      // to contain concrete implementations.
      const arguments_: CallableBorrowIndexArgument[] = argumentsFromTyping.map(
        (argument, parameter) =>
          ({
            parameter,
            ...(() => {
              const bindingKind =
                signature?.parameters[parameter]?.bindingKind ??
                constrainedParameters?.[parameter]?.bindingKind;
              return bindingKind ? { bindingKind } : {};
            })(),
            ...(plans[0]?.[parameter]?.kind === "omitted-default"
              ? { defaulted: true as const }
              : {}),
            ...(typeof argument === "number" ? { expression: argument } : {}),
            ...(typeof argument === "number"
              ? (() => {
                  const rawPlace = placeOfExpression(argument, hir, context);
                  if (!rawPlace) return {};
                  return {
                    place: rawPlace,
                    ...(isStoragePlace(rawPlace)
                      ? { moduleStorage: true as const }
                      : {}),
                    ...(freshBindingRoots.has(rawPlace.root) &&
                    localFreshRootIsUnique(rawPlace.root) &&
                    rawPlace.projections.every(
                      (projection) => projection.kind === "identity",
                    )
                      ? { fresh: true as const }
                      : {}),
                    ...(provenanceFreeFreshBindingRoots.has(rawPlace.root) &&
                    localFreshRootIsUnique(rawPlace.root)
                      ? { provenanceFreeFresh: true as const }
                      : {}),
                    ...(callerParameterOriginsByRoot.has(rawPlace.root)
                      ? {
                          callerParameterOrigins:
                            callerParameterOriginsByRoot.get(rawPlace.root)!,
                        }
                      : {}),
                    ...(compilerArrayIteratorRoots.has(rawPlace.root) &&
                    rawPlace.projections.every(
                      (projection) => projection.kind === "identity",
                    )
                      ? { compilerArrayIterator: true as const }
                      : {}),
                  };
                })()
              : {}),
            ...(typeof argument === "number"
              ? (() => {
                  const argumentType = typeFor(argument, context);
                  return typeof argumentType === "number"
                    ? {
                        type: argumentType,
                        ...(typeCanCarryReference(argumentType, typing)
                          ? { referenceCapable: true as const }
                          : {}),
                        ...(isLoanBearingType(argumentType, typing) ||
                        (signature?.parameters[parameter]?.bindingKind ??
                          constrainedParameters?.[parameter]?.bindingKind) ===
                          "mutable-ref" ||
                        (signature?.parameters[parameter]?.bindingKind ??
                          constrainedParameters?.[parameter]?.bindingKind) ===
                          "immutable-ref"
                          ? { loanBearing: true as const }
                          : {}),
                      }
                    : {};
                })()
              : {}),
          }) satisfies CallableBorrowIndexArgument,
      );
      const compilerArrayIteratorNext =
        expression.exprKind === "method-call" &&
        expression.method === "next" &&
        targets.length === 1 &&
        isCanonicalStdArrayTarget(targets[0]!, "next") &&
        arguments_[0]?.compilerArrayIterator === true &&
        isCanonicalStdArrayIteratorType(arguments_[0]?.type) &&
        isCanonicalStdArrayIteratorType(signature?.parameters[0]?.type);
      const returnsBorrowed =
        (signature !== undefined &&
          isBorrowedType(signature.returnType, typing)) ||
        ((intrinsicName === "__shared_cell_value" ||
          intrinsicName === "__array_get" ||
          intrinsicName === "__array_copy") &&
          isBorrowCapableType(typeFor(exprId, context), typing));
      const maySuspend =
        (signature !== undefined &&
          !typing.effects.isEmpty(signature.effectRow)) ||
        targets.some(targetMaySuspend);
      const indexedCall = {
        exprId,
        span: expression.span,
        targets,
        arguments: arguments_,
        ...(signature ? { signature } : {}),
        intrinsic,
        intrinsicBoundary,
        ...(ordinaryMutationFreeConstruction
          ? { ordinaryMutationFreeConstruction: true as const }
          : {}),
        ...(intrinsicName ? { intrinsicName } : {}),
        ...(expression.exprKind === "method-call"
          ? { methodName: expression.method }
          : {}),
        ...(intrinsicIndex ? { intrinsicIndex } : {}),
        formsExplicitBorrow:
          signature?.parameters.some((parameter) =>
            isBorrowedType(parameter.type, typing),
          ) ?? false,
        returnsBorrowed,
        resultUse: resultUseFor({
          expressionId: exprId,
          returnsBorrowed,
          statement: walkContext.statement,
          parentId: currentParentExpression,
          tailPosition: walkContext.tailPosition,
        }),
        maySuspend,
        ...(argumentPlanAmbiguous
          ? { argumentPlanAmbiguous: true as const }
          : {}),
        ...(traitDispatch ? { traitDispatch: true as const } : {}),
        ...(openTraitDispatch ? { openTraitDispatch: true as const } : {}),
        ...(ordinaryDynamicBound ? { ordinaryDynamicBound } : {}),
        ...(compilerArrayIteratorNext
          ? { compilerArrayIteratorNext: true as const }
          : {}),
      } satisfies CallableBorrowIndexCall;
      const call: CallableBorrowIndexCall = {
        ...indexedCall,
        ...(callIsScopedSharedCellNestedAccess({
          call: indexedCall,
          callableParameters: parameters,
          ambientObjectCaptures: ambientObjectCaptureSet,
          typing,
          symbolTable,
          moduleId: context.moduleId,
          imports: context.imports,
        })
          ? { scopedSharedCellAccess: true as const }
          : {}),
      };
      calls.push(call);
      callsByExpression.set(exprId, call);
      targets.forEach((target) =>
        directCallEdges.set(`${target.moduleId}:${target.symbol}`, target),
      );
      flags.hasSuspension ||= maySuspend;
    },
    onExitStatement: (_statementId, statement) => {
      if (statement.kind !== "let") return;
      const initializerType = typeFor(statement.initializer, context);
      if (
        typeof initializerType === "number" &&
        !typeCanCarryReference(initializerType, typing)
      ) {
        return;
      }
      const origins = callerParameterOriginsForExpression(
        statement.initializer,
      );
      const bindings = bindingSymbols(statement.pattern);
      bindings.forEach((symbol) =>
        callerParameterOriginsByRoot.set(symbol, origins),
      );
      const localSources = referenceSourceRootsForExpression(
        statement.initializer,
      );
      if (localSources.size > 0) {
        recordLocalAliases({
          aliases: bindings,
          sources: localSources,
          aliasesShareIdentity: expressionSharesReferenceIdentity(
            statement.initializer,
          ),
        });
      }
    },
    onExitExpression: (exprId, expression) => {
      if (expression.exprKind === "match") {
        const origins = callerParameterOriginsForExpression(
          expression.discriminant,
        );
        expression.arms.forEach((arm) => {
          const bindings = bindingSymbols(arm.pattern);
          callerParameterOriginTransfers.push({
            targets: bindings,
            expression: expression.discriminant,
          });
          bindings.forEach((symbol) =>
            mergeCallerParameterOrigins(symbol, origins),
          );
        });
      }
      if (
        expression.exprKind === "object-literal" ||
        expression.exprKind === "tuple" ||
        expression.exprKind === "lambda" ||
        expression.exprKind === "if" ||
        expression.exprKind === "cond" ||
        expression.exprKind === "match"
      ) {
        markLocalAliasComponentsNonUnique(
          referenceSourceRootsForExpression(exprId),
        );
      }
      if (
        expression.exprKind === "call" ||
        expression.exprKind === "method-call"
      ) {
        const call = callsByExpression.get(exprId);
        if (call) {
          invalidateRetainableCallArguments(call);
          if (call.compilerArrayIteratorNext !== true) {
            call.arguments.forEach((argument) => {
              if (
                argument.bindingKind === "mutable-ref" &&
                argument.place?.projections.every(
                  (projection) => projection.kind === "identity",
                )
              ) {
                compilerArrayIteratorRoots.delete(argument.place.root);
              }
            });
          }
        }
      }
      if (expression.exprKind !== "assign") {
        return;
      }
      if (typeof expression.target === "number") {
        const targetPlace = placeOfExpression(expression.target, hir, context);
        if (targetPlace) {
          compilerArrayIteratorRoots.delete(targetPlace.root);
          callerParameterOriginTransfers.push({
            targets: [targetPlace.root],
            expression: expression.value,
          });
        }
        const parameter = targetPlace
          ? parameterPlaces.get(targetPlace.root)
          : undefined;
        if (parameter && targetPlace?.projections.length === 0) {
          rootReboundParameters.add(parameter.parameter);
        }
        const sources = referenceSourceRootsForExpression(expression.value);
        if (targetPlace && sources.size > 0) {
          recordLocalAliases({
            aliases: [targetPlace.root],
            sources,
            aliasesShareIdentity: targetPlace.projections.length === 0,
          });
        }
        if (targetPlace) {
          mergeCallerParameterOrigins(
            targetPlace.root,
            callerParameterOriginsForExpression(expression.value),
          );
        }
      }
      if (expression.pattern) {
        callerParameterOriginTransfers.push({
          targets: bindingSymbols(expression.pattern),
          expression: expression.value,
        });
        const sources = referenceSourceRootsForExpression(expression.value);
        if (sources.size > 0) {
          recordLocalAliases({
            aliases: bindingSymbols(expression.pattern),
            sources,
            aliasesShareIdentity: true,
          });
        }
        const origins = callerParameterOriginsForExpression(expression.value);
        bindingSymbols(expression.pattern).forEach((symbol) =>
          mergeCallerParameterOrigins(symbol, origins),
        );
      }
    },
  });

  const originTransferBudget = Math.max(
    64,
    callerParameterOriginTransfers.length * 8,
  );
  let originTransferWork = 0;
  let originsChanged = true;
  while (originsChanged && originTransferWork < originTransferBudget) {
    originsChanged = false;
    for (const transfer of callerParameterOriginTransfers) {
      originTransferWork += 1;
      const origins = callerParameterOriginsForExpression(transfer.expression);
      transfer.targets.forEach((target) => {
        originsChanged =
          mergeCallerParameterOrigins(target, origins) || originsChanged;
      });
      if (originTransferWork >= originTransferBudget) break;
    }
  }
  if (originsChanged) {
    callerParameterOriginTransfers.forEach(({ targets }) =>
      targets.forEach((target) =>
        callerParameterOriginsByRoot.set(target, allReferenceParameterOrigins),
      ),
    );
  }
  incrementCompilerPerfCounter(
    "borrowing.index.sourceOriginTransfers",
    callerParameterOriginTransfers.length,
  );
  incrementCompilerPerfCounter(
    "borrowing.index.sourceOriginTransferWork",
    originTransferWork,
  );
  incrementCompilerPerfCounter(
    "borrowing.index.sourceOriginFallbacks",
    originsChanged ? 1 : 0,
  );

  const defaultHasBorrowFlow = (
    parameter: (typeof callable.parameters)[number],
  ): boolean => {
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
    return (
      intrinsicName === "~" ||
      intrinsicName === "__shared_cell_value" ||
      targets.length === 0 ||
      signatures.length === 0 ||
      targetHasBorrowInput ||
      signatures.some(
        (targetSignature) =>
          isLoanBearingType(targetSignature.returnType, typing) ||
          typeCanCarryReference(targetSignature.returnType, typing),
      )
    );
  };
  flags.hasDefaultBorrowFlow = callable.parameters.some(defaultHasBorrowFlow);

  const scopedSharedCellCalls = new Set(
    calls.flatMap((call) =>
      call.scopedSharedCellAccess === true ? [call.exprId] : [],
    ),
  );
  const ambientCaptureUseIsDirect = (use: {
    root: SymbolId;
    expression: HirExprId;
    parent?: HirExprId;
  }): boolean => {
    if (
      typeof use.parent !== "number" ||
      !scopedSharedCellCalls.has(use.parent)
    ) {
      return true;
    }
    const parent = hir.expressions.get(use.parent);
    return (
      parent?.exprKind !== "method-call" || parent.target !== use.expression
    );
  };
  const directAmbientCaptureUses = ambientObjectCaptureUses.filter(
    ambientCaptureUseIsDirect,
  );
  directAmbientCaptureUses.forEach((use) =>
    directAmbientObjectRoots.add(use.root),
  );
  flags.hasAmbientObjectCapture = directAmbientCaptureUses.length > 0;

  const receiverOwner = typing.memberMetadata.get(callable.symbol)?.owner;
  if (typeof receiverOwner === "number") {
    const metadata = symbolTable.getSymbol(receiverOwner).metadata as
      | { intrinsicType?: unknown }
      | undefined;
    flags.hasRuntimeCheckedReceiverWrites =
      metadata?.intrinsicType === STD_INTRINSIC_TYPE.sharedCell;
  }
  const normalized = normalizeIndex({
    symbol: callable.symbol,
    ...(signature ? { signature } : {}),
    parameters,
    parameterPlaces,
    accesses,
    calls: calls.map((call) => ({
      ...call,
      arguments: call.arguments.map((argument) =>
        argument.referenceCapable === true &&
        typeof argument.expression === "number"
          ? {
              ...argument,
              callerParameterOrigins: callerParameterOriginsForExpression(
                argument.expression,
              ),
              callerParameterOriginPlaces:
                callerParameterOriginPlacesForExpression(argument.expression),
            }
          : argument,
      ),
    })),
    directCallEdges: Array.from(directCallEdges.values()),
    ambientObjectCaptures,
    directAmbientObjectRoots: Array.from(directAmbientObjectRoots),
    mutableAliasSourceRoots,
    rootReboundParameters,
    flags,
  });
  return normalized;
};

const ordinaryDynamicBoundForParameters = (
  parameters: readonly {
    bindingKind?: "value" | "mutable-ref" | "immutable-ref";
  }[],
  maySuspend: boolean,
): NonNullable<CallableBorrowIndexCall["ordinaryDynamicBound"]> => ({
  parameterBindingKinds: parameters.map((parameter) => parameter.bindingKind),
  ambientObjectAccess: false,
  invokesUnknownCallback: false,
  maySuspend,
});

const ordinaryDynamicBoundForTraitMethods = (
  methods: readonly HirTraitMethod[],
  maySuspend: (method: HirTraitMethod) => boolean,
  invokesUnknownCallback: (method: HirTraitMethod) => boolean,
): NonNullable<CallableBorrowIndexCall["ordinaryDynamicBound"]> => {
  const parameterCount = Math.max(
    0,
    ...methods.map((method) => method.parameters.length),
  );
  return {
    parameterBindingKinds: Array.from(
      { length: parameterCount },
      (_, index) => {
        const kinds = methods.map(
          (method) => method.parameters[index]?.bindingKind,
        );
        if (kinds.includes("mutable-ref")) return "mutable-ref";
        return kinds.includes("immutable-ref") ? "immutable-ref" : undefined;
      },
    ),
    ambientObjectAccess: false,
    // An open declaration row admits unknown implementation work. That same
    // openness is the finite callback ceiling for dynamic dispatch.
    invokesUnknownCallback: methods.some(invokesUnknownCallback),
    maySuspend: methods.some(maySuspend),
  };
};

export const parameterPlaceForIndexPlace = (
  index: CallableBorrowIndex,
  place: BorrowPlace | undefined,
): { parameter: number; path: readonly PlaceProjection[] } | undefined => {
  if (!place) return undefined;
  const parameter = index.parameterPlaces.get(place.root);
  return parameter
    ? {
        parameter: parameter.parameter,
        path: [...parameter.path, ...place.projections],
      }
    : undefined;
};

export const indexCallArgumentFor = (
  call: CallableBorrowIndexCall,
  parameter: number,
): CallableBorrowIndexArgument | undefined =>
  call.arguments.find((argument) => argument.parameter === parameter);

const callIsScopedSharedCellNestedAccess = ({
  call,
  callableParameters,
  ambientObjectCaptures,
  typing,
  symbolTable,
  moduleId,
  imports,
}: {
  call: CallableBorrowIndexCall;
  callableParameters: readonly CallableBorrowIndexParameter[];
  ambientObjectCaptures: ReadonlySet<SymbolId>;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
}): boolean => {
  if (
    !callableParameters.some(
      (parameter) =>
        typeof parameter.type === "number" &&
        typing.arena.get(typing.arena.unfoldRecursive(parameter.type)).kind ===
          "borrowed",
    ) ||
    call.targets.length !== 1 ||
    call.traitDispatch === true ||
    call.openTraitDispatch === true ||
    call.argumentPlanAmbiguous === true ||
    !call.methodName ||
    !SCOPED_SHARED_CELL_METHODS.has(call.methodName)
  ) {
    return false;
  }
  const receiver = indexCallArgumentFor(call, 0);
  if (
    !receiver?.place ||
    !ambientObjectCaptures.has(receiver.place.root) ||
    !typeHasIntrinsicRole({
      type: receiver.type,
      role: STD_INTRINSIC_TYPE.sharedCell,
      typing,
      symbolTable,
      moduleId,
      imports,
    })
  ) {
    return false;
  }
  const parameters = call.signature?.parameters;
  if (
    parameters?.length !== 2 ||
    parameters[0]?.bindingKind !== undefined ||
    !typeHasIntrinsicRole({
      type: parameters[0]!.type,
      role: STD_INTRINSIC_TYPE.sharedCell,
      typing,
      symbolTable,
      moduleId,
      imports,
    })
  ) {
    return false;
  }
  const callbackType = typing.arena.get(
    typing.arena.unfoldRecursive(parameters[1]!.type),
  );
  if (
    parameters[1]?.bindingKind !== undefined ||
    callbackType.kind !== "function" ||
    callbackType.parameters.length !== 1 ||
    !typing.effects.isEmpty(callbackType.effectRow)
  ) {
    return false;
  }
  const borrowedInput = callbackType.parameters[0]!;
  if (
    typing.arena.get(typing.arena.unfoldRecursive(borrowedInput.type)).kind !==
    "borrowed"
  ) {
    return false;
  }
  const expectsExclusive =
    call.methodName === "with_mut" || call.methodName === "try_with_mut";
  return expectsExclusive
    ? borrowedInput.bindingKind === "mutable-ref"
    : borrowedInput.bindingKind !== "mutable-ref";
};

const SCOPED_SHARED_CELL_METHODS = new Set([
  "with",
  "with_mut",
  "try_with",
  "try_with_mut",
]);
