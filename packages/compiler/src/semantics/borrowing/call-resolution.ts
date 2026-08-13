import type { SymbolTable } from "../binder/index.js";
import type { DeclTable } from "../decls.js";
import {
  walkExpression,
  type HirExpression,
  type HirGraph,
} from "../hir/index.js";
import type { HirExprId, SymbolId, TypeId } from "../ids.js";
import type { FunctionSignature, TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import { canonicalSymbolRef } from "../typing/symbol-ref-utils.js";
import type { BorrowingDependency } from "./dependency.js";
import type { PlaceProjection } from "./model.js";
import { typeCanCarryReference } from "./reference-bearing.js";

export const BORROW_IRRELEVANT_VALUE_INTRINSICS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "and",
  "or",
  "xor",
  "not",
  "__shift_l",
  "__shift_ru",
  "__bit_and",
  "__bit_or",
  "__bit_xor",
  "__i32_wrap_i64",
  "__i64_extend_u",
  "__i64_extend_s",
  "__i32_trunc_f32_s",
  "__i32_trunc_f64_s",
  "__i64_trunc_f32_s",
  "__i64_trunc_f64_s",
  "__f32_convert_i32_s",
  "__f32_convert_i64_s",
  "__f64_convert_i32_s",
  "__f64_convert_i64_s",
  "__reinterpret_f32_to_i32",
  "__reinterpret_i32_to_f32",
  "__f32_demote_f64",
  "__f64_promote_f32",
  "__floor",
  "__ceil",
  "__round",
  "__trunc",
  "__sqrt",
  "__reinterpret_f64_to_i64",
  "__reinterpret_i64_to_f64",
]);

/** Intrinsics whose finite mutation behavior is completely operand-defined. */
export const COMPACT_BORROW_INTRINSICS = new Set([
  "~",
  "__shared_cell_value",
  "__array_get",
  "__array_set",
  "__array_copy",
  "__array_new",
  "__array_new_fixed",
  "__array_len",
  "__ref_is_null",
]);

export type ResolveContext = {
  hir: HirGraph;
  symbolTable: SymbolTable;
  decls: DeclTable;
  typing: TypingResult;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  bindingInitializers: ReadonlyMap<SymbolId, HirExprId>;
  borrowIndexMode?: "concrete" | "symbolic";
};

const instantiatedExpressionTypesByTyping = new WeakMap<
  TypingResult,
  ReadonlyMap<HirExprId, TypeId>
>();

const instantiatedExpressionTypes = (
  typing: TypingResult,
): ReadonlyMap<HirExprId, TypeId> => {
  const cached = instantiatedExpressionTypesByTyping.get(typing);
  if (cached) return cached;
  const candidates = new Map<
    HirExprId,
    { first: TypeId; reference?: TypeId }
  >();
  typing.functionInstanceExprTypes.forEach((types) =>
    types.forEach((type, expression) => {
      const prior = candidates.get(expression);
      candidates.set(expression, {
        first: prior?.first ?? type,
        reference:
          prior?.reference ??
          (typeCanCarryReference(type, typing) ? type : undefined),
      });
    }),
  );
  const resolved = new Map(
    Array.from(candidates, ([expression, candidate]) => [
      expression,
      candidate.reference ?? candidate.first,
    ]),
  );
  instantiatedExpressionTypesByTyping.set(typing, resolved);
  return resolved;
};

export const expressionTypeFor = (
  expression: HirExprId,
  context: ResolveContext,
  seen = new Set<HirExprId>(),
): TypeId | undefined => {
  const concrete =
    context.typing.resolvedExprTypes.get(expression) ??
    context.typing.table.getExprType(expression);
  const symbolic = context.typing.borrowResolvedExprTypes.get(expression);
  const direct =
    context.borrowIndexMode === "symbolic"
      ? (symbolic ?? concrete)
      : concrete;
  if (typeof direct === "number") return direct;
  const instantiated = instantiatedExpressionTypes(context.typing).get(
    expression,
  );
  if (typeof instantiated === "number" || seen.has(expression)) {
    return instantiated ?? symbolic;
  }
  seen.add(expression);
  const node = context.hir.expressions.get(expression);
  if (node?.exprKind === "identifier") {
    const value = context.typing.valueTypes.get(node.symbol);
    if (typeof value === "number") return value;
    const initializer = context.bindingInitializers.get(node.symbol);
    if (typeof initializer === "number") {
      return expressionTypeFor(initializer, context, seen);
    }
    for (const [, signature] of context.typing.functions.signatures) {
      const parameter = signature.parameters.find(
        (candidate) => candidate.symbol === node.symbol,
      );
      if (parameter) return parameter.type;
    }
  }
  if (node?.exprKind === "call") {
    const callee = context.hir.expressions.get(node.callee);
    if (callee?.exprKind !== "identifier") return undefined;
    const imported = context.imports.get(callee.symbol);
    return imported
      ? context.dependencies
          .get(imported.moduleId)
          ?.callables.get(imported.symbol)?.signature?.returnType
      : context.typing.functions.getSignature(callee.symbol)?.returnType;
  }
  return undefined;
};

const uniqueTargets = (
  expression: HirExprId,
  typing: TypingResult,
  preferSymbolic: boolean,
): readonly SymbolRef[] => {
  const concrete = [...(typing.callTargets.get(expression)?.values() ?? [])];
  const symbolic = [
    ...(typing.borrowCallTargets.get(expression)?.values() ?? []),
  ];
  const selected = preferSymbolic
    ? [...symbolic, ...concrete]
    : concrete.length > 0
      ? concrete
      : symbolic;
  return Array.from(
    new Map(
      selected.map((target) => [
        `${target.moduleId}:${target.symbol}`,
        target,
      ]),
    ).values(),
  );
};

const directTarget = (
  expression: HirExpression,
  context: ResolveContext,
): SymbolRef | undefined => {
  if (expression.exprKind !== "call") return undefined;
  const callee = context.hir.expressions.get(expression.callee);
  if (callee?.exprKind !== "identifier") return undefined;
  const imported = context.imports.get(callee.symbol);
  if (imported) return imported;
  const canonical = canonicalSymbolRef({
    symbol: callee.symbol,
    symbolTable: context.symbolTable,
    moduleId: context.moduleId,
  });
  if (
    canonical.moduleId !== context.moduleId ||
    canonical.symbol !== callee.symbol
  ) {
    return canonical;
  }
  const metadata = context.symbolTable.getSymbol(callee.symbol).metadata as
    | { entity?: unknown }
    | undefined;
  return context.typing.functions.getSignature(callee.symbol) ||
    metadata?.entity === "trait-method"
    ? { moduleId: context.moduleId, symbol: callee.symbol }
    : undefined;
};

const traitDefaultCallTargets = new WeakMap<
  HirGraph,
  ReadonlyMap<HirExprId, readonly SymbolRef[]>
>();

const traitDefaultTargetsFor = (
  expression: HirExpression,
  context: ResolveContext,
): readonly SymbolRef[] => {
  if (expression.exprKind !== "method-call") return [];
  let targetsByExpression = traitDefaultCallTargets.get(context.hir);
  if (!targetsByExpression) {
    const targets = new Map<HirExprId, readonly SymbolRef[]>();
    Array.from(context.hir.items.values()).forEach((item) => {
      if (item.kind !== "trait") return;
      const methodsByName = new Map<string, SymbolRef[]>();
      item.methods.forEach((method) => {
        const name = context.symbolTable.getSymbol(method.symbol).name;
        const entries = methodsByName.get(name) ?? [];
        entries.push({ moduleId: context.moduleId, symbol: method.symbol });
        methodsByName.set(name, entries);
      });
      item.methods.forEach((method) => {
        if (typeof method.defaultBody !== "number") return;
        walkExpression({
          exprId: method.defaultBody,
          hir: context.hir,
          onEnterExpression: (expressionId, nested) => {
            if (nested.exprKind !== "method-call") return;
            const entries = methodsByName.get(nested.method);
            if (entries) targets.set(expressionId, entries);
          },
        });
      });
    });
    targetsByExpression = targets;
    traitDefaultCallTargets.set(context.hir, targetsByExpression);
  }
  return targetsByExpression.get(expression.id) ?? [];
};

export const resolveBorrowCallTargets = (
  expression: HirExpression,
  context: ResolveContext,
): readonly SymbolRef[] => {
  const resolved = uniqueTargets(
    expression.id,
    context.typing,
    context.borrowIndexMode === "symbolic",
  );
  if (resolved.length > 0) return resolved;
  const traitDefaults = traitDefaultTargetsFor(expression, context);
  if (traitDefaults.length > 0) return traitDefaults;
  const direct = directTarget(expression, context);
  return direct ? [direct] : [];
};

export const callHasIntrinsicBorrowBoundary = (
  expression: HirExpression,
  context: ResolveContext,
): boolean => {
  if (expression.exprKind !== "call") return false;
  const callee = context.hir.expressions.get(expression.callee);
  if (callee?.exprKind !== "identifier") return false;
  const metadata = context.symbolTable.getSymbol(callee.symbol).metadata as
    | { intrinsic?: boolean }
    | undefined;
  if (
    metadata?.intrinsic !== true ||
    context.decls.getEffectOperation(callee.symbol)
  ) {
    return false;
  }
  const targets = resolveBorrowCallTargets(expression, context);
  return targets.every((target) => {
    if (target.moduleId !== context.moduleId) return false;
    const targetMetadata = context.symbolTable.getSymbol(target.symbol)
      .metadata as { intrinsic?: boolean } | undefined;
    return targetMetadata?.intrinsic === true;
  });
};

const projectedTypesCache = new WeakMap<
  TypingResult,
  Map<TypeId, Map<string, readonly TypeId[]>>
>();

const projectionPathKey = (
  projections: readonly PlaceProjection[],
): string => JSON.stringify(projections);

const projectedTypeFields = (
  type: TypeId,
  typing: TypingResult,
):
  | { byName: ReadonlyMap<string, TypeId>; byIndex: readonly TypeId[] }
  | undefined => {
  const descriptor = typing.arena.get(type);
  const fields =
    descriptor.kind === "structural-object"
      ? descriptor.fields
      : descriptor.kind === "nominal-object" ||
          descriptor.kind === "value-object"
        ? typing.objectsByNominal.get(type)?.fields
        : undefined;
  return fields
    ? {
        byName: new Map(fields.map((field) => [field.name, field.type])),
        byIndex: fields.map((field) => field.type),
      }
    : undefined;
};

export const projectedTypes = (
  type: TypeId,
  projections: readonly PlaceProjection[],
  typing: TypingResult,
): readonly TypeId[] => {
  let byType = projectedTypesCache.get(typing);
  if (!byType) {
    byType = new Map();
    projectedTypesCache.set(typing, byType);
  }
  let byPath = byType.get(type);
  if (!byPath) {
    byPath = new Map();
    byType.set(type, byPath);
  }
  const key = projectionPathKey(projections);
  const cached = byPath.get(key);
  if (cached) return cached;
  const result = resolveProjectedTypes(
    type,
    projections,
    typing,
    new Set(),
  );
  byPath.set(key, result);
  return result;
};

const resolveProjectedTypes = (
  type: TypeId,
  projections: readonly PlaceProjection[],
  typing: TypingResult,
  active: Set<TypeId>,
): readonly TypeId[] => {
  if (projections.length === 0) return [type];
  if (active.has(type)) return [];
  active.add(type);
  const descriptor = typing.arena.get(type);
  const [projection, ...remaining] = projections;
  const result = (() => {
    if (projection?.kind === "dereference" || projection?.kind === "identity") {
      return resolveProjectedTypes(type, remaining, typing, new Set());
    }
    if (descriptor.kind === "borrowed") {
      return resolveProjectedTypes(
        descriptor.inner,
        projections,
        typing,
        active,
      );
    }
    if (descriptor.kind === "recursive") {
      return resolveProjectedTypes(
        descriptor.body,
        projections,
        typing,
        active,
      );
    }
    if (descriptor.kind === "union") {
      return descriptor.members.flatMap((member) =>
        resolveProjectedTypes(member, projections, typing, new Set(active)),
      );
    }
    if (descriptor.kind === "intersection") {
      return [descriptor.nominal, descriptor.structural].flatMap((member) =>
        typeof member === "number"
          ? resolveProjectedTypes(member, projections, typing, new Set(active))
          : [],
      );
    }
    if (projection?.kind === "index" && descriptor.kind === "fixed-array") {
      return resolveProjectedTypes(
        descriptor.element,
        remaining,
        typing,
        active,
      );
    }
    const fields = projectedTypeFields(type, typing);
    const field =
      projection?.kind === "field"
        ? fields?.byName.get(projection.name)
        : projection?.kind === "tuple"
          ? fields?.byIndex[projection.index]
          : undefined;
    return typeof field === "number"
      ? resolveProjectedTypes(field, remaining, typing, active)
      : [];
  })();
  active.delete(type);
  return result;
};

/** Signature projection used by finite callers without legacy contracts. */
export const signatureForTarget = (
  target: SymbolRef,
  context: ResolveContext,
): Pick<FunctionSignature, "parameters" | "returnType" | "effectRow"> | undefined =>
  target.moduleId === context.moduleId
    ? context.typing.functions.getSignature(target.symbol)
    : context.dependencies.get(target.moduleId)?.callables.get(target.symbol)
        ?.signature;
