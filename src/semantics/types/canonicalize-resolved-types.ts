import { Expr } from "../../syntax-objects/expr.js";
import { List } from "../../syntax-objects/list.js";
import { VoydModule } from "../../syntax-objects/module.js";
import { Fn } from "../../syntax-objects/fn.js";
import { Closure } from "../../syntax-objects/closure.js";
import { Macro } from "../../syntax-objects/macros.js";
import { MacroLambda } from "../../syntax-objects/macro-lambda.js";
import { MacroVariable } from "../../syntax-objects/macro-variable.js";
import { Variable } from "../../syntax-objects/variable.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { Call } from "../../syntax-objects/call.js";
import { ObjectLiteral, ObjectLiteralField } from "../../syntax-objects/object-literal.js";
import { ArrayLiteral } from "../../syntax-objects/array-literal.js";
import { Match, MatchCase } from "../../syntax-objects/match.js";
import { Implementation } from "../../syntax-objects/implementation.js";
import {
  FixedArrayType,
  FnType,
  IntersectionType,
  ObjectType,
  TupleType,
  Type,
  TypeAlias,
  UnionType,
  VoydRefType,
} from "../../syntax-objects/types.js";
import { TraitType } from "../../syntax-objects/types/trait.js";
import {
  CanonicalTypeDedupeEvent,
  CanonicalTypeTable,
} from "./canonical-type-table.js";
import { typeKey } from "./type-key.js";

const CANON_DEBUG = Boolean(process.env.CANON_DEBUG);

export type CanonicalizationIssue = {
  fingerprint: string;
  canonical: Type;
  duplicate: Type;
  canonicalContext: string[];
  duplicateContext: string[];
};

type CanonicalizeResolvedTypesOpts = {
  table?: CanonicalTypeTable;
  onDuplicate?: (issue: CanonicalizationIssue) => void;
};

type CanonicalizeCtx = {
  visitedExpr: Set<Expr>;
  visitedTypes: Set<Type>;
  fingerprintOwners: Map<string, Type>;
  issues: CanonicalizationIssue[];
  events: CanonicalTypeDedupeEvent[];
  table?: CanonicalTypeTable;
  onDuplicate?: (issue: CanonicalizationIssue) => void;
};

const describeSyntaxNode = (node: Expr | undefined): string | undefined => {
  if (!node) return undefined;
  const base = node as any;
  const label = base.syntaxType ?? base.constructor?.name ?? "<unknown>";
  const identifier =
    (base.name && base.name.toString?.()) ??
    base.id ??
    (typeof base.syntaxId === "number" ? `#${base.syntaxId}` : undefined);
  const entry = identifier ? `${label}(${identifier})` : label;
  const location = base.location?.toString?.();
  return location ? `${entry}@${location}` : entry;
};

const traceSyntaxChain = (start: Expr | undefined, limit = 5): string[] => {
  const chain: string[] = [];
  let current: Expr | undefined = start;
  while (current && chain.length < limit) {
    const label = describeSyntaxNode(current);
    if (label) chain.push(label);
    current = current.parent;
  }
  return chain;
};

const isVoydRefType = (value: Type | undefined): value is VoydRefType =>
  !!value?.isRefType?.();

const recordDuplicate = (
  ctx: CanonicalizeCtx,
  fingerprint: string,
  canonical: Type,
  duplicate: Type
): void => {
  const issue: CanonicalizationIssue = {
    fingerprint,
    canonical,
    duplicate,
    canonicalContext: traceSyntaxChain(canonical.parent as Expr | undefined),
    duplicateContext: traceSyntaxChain(duplicate.parent as Expr | undefined),
  };

  ctx.issues.push(issue);
  ctx.events.push({ fingerprint, canonical, reused: duplicate });

  if (CANON_DEBUG) {
    console.warn("[CANON_DEBUG] duplicate type fingerprint detected", {
      fingerprint,
      canonical: describeSyntaxNode(canonical),
      duplicate: describeSyntaxNode(duplicate),
      canonicalContext: issue.canonicalContext,
      duplicateContext: issue.duplicateContext,
    });
  }

  if (ctx.onDuplicate) {
    ctx.onDuplicate(issue);
  }
};

const registerTypeFingerprint = (ctx: CanonicalizeCtx, type: Type): void => {
  if (!isVoydRefType(type)) return;
  let fingerprint: string;
  try {
    fingerprint = typeKey(type);
  } catch (error) {
    if (CANON_DEBUG) {
      console.warn("[CANON_DEBUG] failed to compute type fingerprint", {
        type: describeSyntaxNode(type),
        error,
      });
    }
    return;
  }
  const existing = ctx.fingerprintOwners.get(fingerprint);
  if (!existing || existing === type) {
    ctx.fingerprintOwners.set(fingerprint, type);
    return;
  }
  recordDuplicate(ctx, fingerprint, existing, type);
};

export const canonicalizeResolvedTypes = (
  module: VoydModule,
  opts: CanonicalizeResolvedTypesOpts = {}
): VoydModule => {
  const ctx: CanonicalizeCtx = {
    visitedExpr: new Set(),
    visitedTypes: new Set(),
    fingerprintOwners: new Map(),
    issues: [],
    events: [],
    table: opts.table,
    onDuplicate: opts.onDuplicate,
  };

  validateExpr(ctx, module);

  if (ctx.table) {
    ctx.table.clearDedupeEvents();
    ctx.table.setDedupeEvents(ctx.events);
  }

  return module;
};

const validateExpr = (ctx: CanonicalizeCtx, expr?: Expr): void => {
  if (!expr || ctx.visitedExpr.has(expr)) return;
  ctx.visitedExpr.add(expr);

  const maybeType = (expr as any)?.type as Type | undefined;
  if (maybeType) validateType(ctx, maybeType);

  const maybeOriginalType = (expr as any)?.originalType as Type | undefined;
  if (maybeOriginalType) validateType(ctx, maybeOriginalType);

  if (expr.isModule()) {
    expr.each((child) => validateExpr(ctx, child));
    return;
  }

  if (expr.isFn()) {
    validateFn(ctx, expr);
    return;
  }

  if (expr.isClosure()) {
    validateClosure(ctx, expr);
    return;
  }

  if (expr.isMacro()) {
    validateMacro(ctx, expr);
    return;
  }

  if (expr.isMacroLambda()) {
    validateMacroLambda(ctx, expr);
    return;
  }

  if (expr.isMacroVariable()) {
    validateMacroVariable(ctx, expr);
    return;
  }

  if (expr.isVariable()) {
    validateVariable(ctx, expr);
    return;
  }

  if (expr.isParameter()) {
    validateParameter(ctx, expr);
    return;
  }

  if (expr.isBlock()) {
    expr.body.forEach((child) => validateExpr(ctx, child));
    return;
  }

  if (expr.isCall()) {
    validateCall(ctx, expr);
    return;
  }

  if (expr.isObjectLiteral()) {
    validateObjectLiteral(ctx, expr);
    return;
  }

  if (expr.isArrayLiteral()) {
    validateArrayLiteral(ctx, expr);
    return;
  }

  if (expr.isMatch()) {
    validateMatch(ctx, expr);
    return;
  }

  if (expr.isImpl()) {
    validateImplementation(ctx, expr);
    return;
  }

  if (expr.isDeclaration()) {
    expr.fns.forEach((fn) => validateExpr(ctx, fn));
    return;
  }

  if (expr.isGlobal()) {
    if (expr.type) validateType(ctx, expr.type);
    validateExpr(ctx, expr.initializer);
    return;
  }

  if (expr.isTrait()) {
    validateType(ctx, expr);
    return;
  }

  if (expr.isType()) {
    validateType(ctx, expr);
    return;
  }

  if (expr.isIdentifier()) {
    if (expr.type) validateType(ctx, expr.type);
    return;
  }

  if (expr.isList()) {
    validateList(ctx, expr);
  }
};

const validateList = (ctx: CanonicalizeCtx, list?: List): void => {
  if (!list) return;
  list.each((item) => validateExpr(ctx, item));
};

const validateObjectLiteral = (
  ctx: CanonicalizeCtx,
  literal: ObjectLiteral
): void => {
  if (literal.type) validateType(ctx, literal.type);
  literal.fields.forEach((field) => validateObjectLiteralField(ctx, field));
};

const validateObjectLiteralField = (
  ctx: CanonicalizeCtx,
  field: ObjectLiteralField
): void => {
  if (field.type) validateType(ctx, field.type);
  validateExpr(ctx, field.initializer);
};

const validateArrayLiteral = (
  ctx: CanonicalizeCtx,
  literal: ArrayLiteral
): void => {
  const inferred = literal.getAttribute?.("inferredElemType") as Type | undefined;
  if (inferred) validateType(ctx, inferred);
  literal.elements.forEach((element) => validateExpr(ctx, element));
};

const validateMatch = (ctx: CanonicalizeCtx, match: Match): void => {
  if (match.type) validateType(ctx, match.type);
  if (match.baseType) validateType(ctx, match.baseType);
  validateExpr(ctx, match.operand);
  if (match.bindVariable) validateVariable(ctx, match.bindVariable);
  validateExpr(ctx, match.bindIdentifier);
  match.cases.forEach((caseItem) => validateMatchCase(ctx, caseItem));
  if (match.defaultCase) validateMatchCase(ctx, match.defaultCase);
};

const validateMatchCase = (ctx: CanonicalizeCtx, caseItem: MatchCase): void => {
  if (caseItem.matchType) validateType(ctx, caseItem.matchType);
  if (caseItem.matchTypeExpr) validateExpr(ctx, caseItem.matchTypeExpr);
  validateExpr(ctx, caseItem.expr);
};

const validateImplementation = (
  ctx: CanonicalizeCtx,
  impl: Implementation
): void => {
  if (impl.targetType) validateType(ctx, impl.targetType);
  if (impl.trait) validateType(ctx, impl.trait);
  validateExpr(ctx, impl.targetTypeExpr.value);
  validateExpr(ctx, impl.body.value);
  validateExpr(ctx, impl.traitExpr.value);
  impl.typeParams.toArray().forEach((param) => validateExpr(ctx, param));
  impl.exports.forEach((fn) => validateExpr(ctx, fn));
  impl.methods.forEach((fn) => validateExpr(ctx, fn));
};

const validateFn = (ctx: CanonicalizeCtx, fn: Fn): void => {
  if (fn.returnType) validateType(ctx, fn.returnType);
  if (fn.inferredReturnType) validateType(ctx, fn.inferredReturnType);
  if (fn.annotatedReturnType) validateType(ctx, fn.annotatedReturnType);

  fn.appliedTypeArgs?.forEach((arg) => validateType(ctx, arg));

  fn.parameters.forEach((param) => validateParameter(ctx, param));
  fn.variables.forEach((variable) => validateVariable(ctx, variable));
  fn.typeParameters?.forEach((param) => validateExpr(ctx, param));

  const instances = fn.genericInstances;
  if (instances) {
    instances.forEach((inst) => validateExpr(ctx, inst));
  }

  if (fn.body) validateExpr(ctx, fn.body);
  if (fn.returnTypeExpr) validateExpr(ctx, fn.returnTypeExpr);
};

const validateClosure = (ctx: CanonicalizeCtx, closure: Closure): void => {
  if (closure.returnType) validateType(ctx, closure.returnType);
  if (closure.inferredReturnType) validateType(ctx, closure.inferredReturnType);
  if (closure.annotatedReturnType)
    validateType(ctx, closure.annotatedReturnType);

  const parameterFnType = closure.getAttribute?.(
    "parameterFnType"
  ) as Type | undefined;
  if (parameterFnType) validateType(ctx, parameterFnType);

  closure.parameters.forEach((param) => validateParameter(ctx, param));
  closure.variables.forEach((variable) => validateVariable(ctx, variable));
  closure.captures.forEach((capture) => {
    if (capture.isVariable?.()) validateVariable(ctx, capture as Variable);
    else if (capture.isParameter?.())
      validateParameter(ctx, capture as Parameter);
  });

  if (closure.returnTypeExpr) validateExpr(ctx, closure.returnTypeExpr);
  validateExpr(ctx, closure.body);
};

const validateMacro = (ctx: CanonicalizeCtx, macro: Macro): void => {
  macro.parameters.forEach((param) => validateExpr(ctx, param));
  validateExpr(ctx, macro.body);
};

const validateMacroLambda = (
  ctx: CanonicalizeCtx,
  lambda: MacroLambda
): void => {
  lambda.parameters.forEach((param) => validateExpr(ctx, param));
  validateList(ctx, lambda.body);
};

const validateMacroVariable = (
  ctx: CanonicalizeCtx,
  variable: MacroVariable
): void => {
  if (variable.value) validateExpr(ctx, variable.value);
};

const validateParameter = (ctx: CanonicalizeCtx, parameter: Parameter): void => {
  if (parameter.type) validateType(ctx, parameter.type);
  if (parameter.originalType) validateType(ctx, parameter.originalType);
  if (parameter.typeExpr) validateExpr(ctx, parameter.typeExpr);
};

const validateVariable = (ctx: CanonicalizeCtx, variable: Variable): void => {
  if (variable.type) validateType(ctx, variable.type);
  if (variable.originalType) validateType(ctx, variable.originalType);
  if (variable.inferredType) validateType(ctx, variable.inferredType);
  if (variable.annotatedType) validateType(ctx, variable.annotatedType);
  if (variable.typeExpr) validateExpr(ctx, variable.typeExpr);
  validateExpr(ctx, variable.initializer);
};

const validateCall = (ctx: CanonicalizeCtx, call: Call): void => {
  const callType =
    typeof call.getType === "function" ? call.getType() : call.type;
  if (callType) validateType(ctx, callType);
  const expected = call.getAttribute?.("expectedType") as Type | undefined;
  if (expected) validateType(ctx, expected);
  validateExpr(ctx, call.fnName);
  validateList(ctx, call.args);
  validateList(ctx, call.typeArgs ?? undefined);
  const fn = call.fn;
  if (fn) {
    if (fn.isFn?.()) validateExpr(ctx, fn as unknown as Expr);
    if ((fn as ObjectType).isObjectType?.()) validateType(ctx, fn as ObjectType);
  }
};

const validateType = (ctx: CanonicalizeCtx, type?: Type): void => {
  if (!type || ctx.visitedTypes.has(type)) return;
  ctx.visitedTypes.add(type);

  registerTypeFingerprint(ctx, type);

  if ((type as TypeAlias).isTypeAlias?.()) {
    const alias = type as TypeAlias;
    if (alias.type) validateType(ctx, alias.type);
    validateExpr(ctx, alias.typeExpr);
    alias.typeParameters?.forEach((param) => validateExpr(ctx, param));
    return;
  }

  if ((type as UnionType).isUnionType?.()) {
    const union = type as UnionType;
    union.childTypeExprs.toArray().forEach((expr) => validateExpr(ctx, expr));
    union.types.forEach((child) => validateType(ctx, child));
    return;
  }

  if ((type as IntersectionType).isIntersectionType?.()) {
    const inter = type as IntersectionType;
    if (inter.nominalType) validateType(ctx, inter.nominalType);
    if (inter.structuralType) validateType(ctx, inter.structuralType);
    if (inter.nominalTypeExpr?.value)
      validateExpr(ctx, inter.nominalTypeExpr.value);
    if (inter.structuralTypeExpr?.value)
      validateExpr(ctx, inter.structuralTypeExpr.value);
    return;
  }

  if ((type as TupleType).isTupleType?.()) {
    const tuple = type as TupleType;
    tuple.value.forEach((entry) => validateType(ctx, entry));
    return;
  }

  if ((type as FixedArrayType).isFixedArrayType?.()) {
    const arr = type as FixedArrayType;
    if (arr.elemType) validateType(ctx, arr.elemType);
    if (arr.elemTypeExpr) validateExpr(ctx, arr.elemTypeExpr);
    return;
  }

  if ((type as FnType).isFnType?.()) {
    const fn = type as FnType;
    if (fn.returnType) validateType(ctx, fn.returnType);
    fn.parameters.forEach((param) => validateParameter(ctx, param));
    if (fn.returnTypeExpr) validateExpr(ctx, fn.returnTypeExpr);
    return;
  }

  if ((type as ObjectType).isObjectType?.()) {
    const obj = type as ObjectType;
    if (obj.parentObjType) validateType(ctx, obj.parentObjType);
    if (obj.parentObjExpr) validateExpr(ctx, obj.parentObjExpr);
    obj.appliedTypeArgs?.forEach((arg) => validateType(ctx, arg));
    obj.fields.forEach((field) => {
      if (field.type) validateType(ctx, field.type);
      validateExpr(ctx, field.typeExpr);
    });
    obj.implementations.forEach((impl) => validateExpr(ctx, impl));
    obj.genericInstances?.forEach((inst) => validateType(ctx, inst));
    if (obj.genericParent) validateType(ctx, obj.genericParent);
    obj.typeParameters?.forEach((param) => validateExpr(ctx, param));
    return;
  }

  if ((type as TraitType).isTraitType?.()) {
    const trait = type as TraitType;
    trait.appliedTypeArgs?.forEach((arg) => validateType(ctx, arg));
    trait.methods.toArray().forEach((method) => validateExpr(ctx, method));
    trait.implementations.forEach((impl) => validateExpr(ctx, impl));
    trait.genericInstances?.forEach((inst) => validateType(ctx, inst));
    if (trait.genericParent) validateType(ctx, trait.genericParent);
    trait.typeParameters?.forEach((param) => validateExpr(ctx, param));
  }
};

export default canonicalizeResolvedTypes;
