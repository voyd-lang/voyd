import { Expr } from "../../syntax-objects/expr.js";
import { List } from "../../syntax-objects/list.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { Variable } from "../../syntax-objects/variable.js";
import { Fn } from "../../syntax-objects/fn.js";
import { Closure } from "../../syntax-objects/closure.js";
import { VoydModule } from "../../syntax-objects/module.js";
import {
  ObjectLiteral,
  ObjectLiteralField,
} from "../../syntax-objects/object-literal.js";
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
} from "../../syntax-objects/types.js";
import { CanonicalTypeTable } from "./canonical-type-table.js";
import { TraitType } from "../../syntax-objects/types/trait.js";

type CanonicalizeCtx = {
  table: CanonicalTypeTable;
  visitedExpr: Set<Expr>;
  visitedTypes: Set<Type>;
};

const dedupeByRef = <T>(values: T[]): T[] => {
  const seen = new Set<T>();
  const result: T[] = [];
  values.forEach((value) => {
    if (seen.has(value)) return;
    seen.add(value);
    result.push(value);
  });
  return result;
};

const dedupeImplementations = (
  impls: Implementation[] | undefined
): Implementation[] | undefined => {
  if (!impls?.length) return impls;
  const seen = new Set<string>();
  const result: Implementation[] = [];
  impls.forEach((impl) => {
    const key = impl.trait ? `trait:${impl.trait.id}` : `inherent:${impl.syntaxId}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(impl);
  });
  return result;
};

type CanonicalizeResolvedTypesOpts = {
  table?: CanonicalTypeTable;
};

export const canonicalizeResolvedTypes = (
  module: VoydModule,
  opts?: CanonicalizeResolvedTypesOpts
): VoydModule => {
  const ctx: CanonicalizeCtx = {
    table: opts?.table ?? new CanonicalTypeTable(),
    visitedExpr: new Set(),
    visitedTypes: new Set(),
  };

  canonicalizeExpr(ctx, module);
  return module;
};

const canonicalTypeRef = (
  ctx: CanonicalizeCtx,
  type?: Type
): Type | undefined => {
  const canonical = ctx.table.canonicalize(type);
  if (canonical) {
    canonicalizeTypeNode(ctx, canonical);
    return ctx.table.getCanonical(canonical);
  }
  return canonical;
};

const canonicalizeExpr = (ctx: CanonicalizeCtx, expr?: Expr): void => {
  if (!expr || ctx.visitedExpr.has(expr)) return;
  ctx.visitedExpr.add(expr);

  if (expr.isModule()) {
    expr.each((child) => canonicalizeExpr(ctx, child));
    return;
  }

  if (expr.isFn()) {
    canonicalizeFn(ctx, expr);
    return;
  }

  if (expr.isClosure()) {
    canonicalizeClosure(ctx, expr);
    return;
  }

  if (expr.isVariable()) {
    canonicalizeVariable(ctx, expr);
    return;
  }

  if (expr.isParameter()) {
    canonicalizeParameter(ctx, expr);
    return;
  }

  if (expr.isBlock()) {
    if (expr.type) expr.type = canonicalTypeRef(ctx, expr.type);
    expr.body.forEach((child) => canonicalizeExpr(ctx, child));
    return;
  }

  if (expr.isCall()) {
    const type = canonicalTypeRef(ctx, expr.type);
    expr.type = type;
    canonicalizeExpr(ctx, expr.fnName);
    canonicalizeList(ctx, expr.args);
    canonicalizeList(ctx, expr.typeArgs ?? undefined);
    const fn = expr.fn;
    if (fn) {
      if (fn.isFn?.()) canonicalizeExpr(ctx, fn);
      if ((fn as ObjectType).isObjectType?.()) {
        expr.fn = canonicalTypeRef(ctx, fn as ObjectType) as ObjectType;
      }
    }
    return;
  }

  if (expr.isObjectLiteral()) {
    canonicalizeObjectLiteral(ctx, expr);
    return;
  }

  if (expr.isArrayLiteral()) {
    expr.elements.forEach((element) => canonicalizeExpr(ctx, element));
    return;
  }

  if (expr.isMatch()) {
    canonicalizeMatch(ctx, expr);
    return;
  }

  if (expr.isImpl()) {
    canonicalizeImplementation(ctx, expr);
    return;
  }

  if (expr.isDeclaration()) {
    expr.fns.forEach((fn) => canonicalizeExpr(ctx, fn));
    return;
  }

  if (expr.isGlobal()) {
    const canonical = canonicalTypeRef(ctx, expr.type);
    if (canonical) (expr as any).type = canonical;
    canonicalizeExpr(ctx, expr.initializer);
    return;
  }

  if (expr.isTrait()) {
    canonicalizeTypeNode(ctx, expr);
    return;
  }

  if (expr.isType()) {
    canonicalizeTypeNode(ctx, expr);
    return;
  }

  if (expr.isIdentifier()) {
    if (expr.type) expr.type = canonicalTypeRef(ctx, expr.type);
    return;
  }

  if (expr.isList()) {
    canonicalizeList(ctx, expr);
    return;
  }
};

const canonicalizeList = (ctx: CanonicalizeCtx, list?: List): void => {
  if (!list) return;
  list.each((item) => canonicalizeExpr(ctx, item));
};

const canonicalizeObjectLiteral = (
  ctx: CanonicalizeCtx,
  literal: ObjectLiteral
): void => {
  if (literal.type)
    literal.type = canonicalTypeRef(ctx, literal.type) as ObjectType;
  literal.fields.forEach((field) => canonicalizeObjectLiteralField(ctx, field));
};

const canonicalizeObjectLiteralField = (
  ctx: CanonicalizeCtx,
  field: ObjectLiteralField
): void => {
  if (field.type) field.type = canonicalTypeRef(ctx, field.type);
  canonicalizeExpr(ctx, field.initializer);
};

const canonicalizeMatch = (ctx: CanonicalizeCtx, match: Match): void => {
  if (match.type) match.type = canonicalTypeRef(ctx, match.type);
  if (match.baseType) match.baseType = canonicalTypeRef(ctx, match.baseType);
  canonicalizeExpr(ctx, match.operand);
  if (match.bindVariable) canonicalizeVariable(ctx, match.bindVariable);
  canonicalizeExpr(ctx, match.bindIdentifier);
  match.cases.forEach((caseItem) => canonicalizeMatchCase(ctx, caseItem));
  if (match.defaultCase) canonicalizeMatchCase(ctx, match.defaultCase);
};

const canonicalizeMatchCase = (
  ctx: CanonicalizeCtx,
  caseItem: MatchCase
): void => {
  if (caseItem.matchType)
    caseItem.matchType = canonicalTypeRef(ctx, caseItem.matchType) as any;
  if (caseItem.matchTypeExpr) canonicalizeExpr(ctx, caseItem.matchTypeExpr);
  canonicalizeExpr(ctx, caseItem.expr);
};

const canonicalizeImplementation = (
  ctx: CanonicalizeCtx,
  impl: Implementation
): void => {
  if (impl.targetType) impl.targetType = canonicalTypeRef(ctx, impl.targetType);
  if (impl.trait) impl.trait = canonicalTypeRef(ctx, impl.trait) as TraitType;
  canonicalizeExpr(ctx, impl.targetTypeExpr.value);
  canonicalizeExpr(ctx, impl.body.value);
  canonicalizeExpr(ctx, impl.traitExpr.value);
  impl.typeParams.toArray().forEach((param) => canonicalizeExpr(ctx, param));
  impl.exports.forEach((fn) => canonicalizeExpr(ctx, fn));
  impl.methods.forEach((fn) => canonicalizeExpr(ctx, fn));
};

const canonicalizeFn = (ctx: CanonicalizeCtx, fn: Fn): void => {
  if (fn.returnType) fn.returnType = canonicalTypeRef(ctx, fn.returnType);
  if (fn.inferredReturnType)
    fn.inferredReturnType = canonicalTypeRef(ctx, fn.inferredReturnType);
  if (fn.annotatedReturnType)
    fn.annotatedReturnType = canonicalTypeRef(ctx, fn.annotatedReturnType);

  if (fn.appliedTypeArgs?.length) {
    fn.appliedTypeArgs = fn.appliedTypeArgs.map(
      (arg) => canonicalTypeRef(ctx, arg)!
    );
  }

  fn.parameters.forEach((param) => canonicalizeParameter(ctx, param));
  fn.variables.forEach((variable) => canonicalizeVariable(ctx, variable));
  fn.typeParameters?.forEach((param) => canonicalizeExpr(ctx, param));

  const instances = fn.genericInstances;
  if (instances) instances.forEach((inst) => canonicalizeExpr(ctx, inst));

  if (fn.body) canonicalizeExpr(ctx, fn.body);
  if (fn.returnTypeExpr) canonicalizeExpr(ctx, fn.returnTypeExpr);
};

const canonicalizeClosure = (ctx: CanonicalizeCtx, closure: Closure): void => {
  if (closure.returnType)
    closure.returnType = canonicalTypeRef(ctx, closure.returnType);
  if (closure.inferredReturnType)
    closure.inferredReturnType = canonicalTypeRef(
      ctx,
      closure.inferredReturnType
    );
  if (closure.annotatedReturnType)
    closure.annotatedReturnType = canonicalTypeRef(
      ctx,
      closure.annotatedReturnType
    );

  closure.parameters.forEach((param) => canonicalizeParameter(ctx, param));
  closure.variables.forEach((variable) => canonicalizeVariable(ctx, variable));
  closure.captures.forEach((capture) => canonicalizeExpr(ctx, capture));

  if (closure.returnTypeExpr) canonicalizeExpr(ctx, closure.returnTypeExpr);
  canonicalizeExpr(ctx, closure.body);
};

const canonicalizeParameter = (
  ctx: CanonicalizeCtx,
  parameter: Parameter
): void => {
  if (parameter.type) parameter.type = canonicalTypeRef(ctx, parameter.type);
  if (parameter.originalType)
    parameter.originalType = canonicalTypeRef(ctx, parameter.originalType);
  if (parameter.typeExpr) canonicalizeExpr(ctx, parameter.typeExpr);
};

const canonicalizeVariable = (
  ctx: CanonicalizeCtx,
  variable: Variable
): void => {
  if (variable.type) variable.type = canonicalTypeRef(ctx, variable.type);
  if (variable.originalType)
    variable.originalType = canonicalTypeRef(ctx, variable.originalType);
  if (variable.annotatedType)
    variable.annotatedType = canonicalTypeRef(ctx, variable.annotatedType);
  if (variable.inferredType)
    variable.inferredType = canonicalTypeRef(ctx, variable.inferredType);
  if (variable.typeExpr) canonicalizeExpr(ctx, variable.typeExpr);
  canonicalizeExpr(ctx, variable.initializer);
};

const canonicalizeTypeNode = (
  ctx: CanonicalizeCtx,
  type: Type
): Type | undefined => {
  if ((type as TypeAlias).isTypeAlias?.()) {
    const alias = type as TypeAlias;
    if (ctx.visitedTypes.has(alias)) return alias;
    ctx.visitedTypes.add(alias);
    if (alias.typeExpr) canonicalizeExpr(ctx, alias.typeExpr);
    if (alias.type) alias.type = canonicalTypeRef(ctx, alias.type);
    return alias.type ?? alias;
  }

  const canonical = ctx.table.canonicalize(type);
  if (!canonical) return undefined;
  if (ctx.visitedTypes.has(canonical)) return canonical;
  ctx.visitedTypes.add(canonical);

  if ((canonical as UnionType).isUnionType?.()) {
    const union = canonical as UnionType;
    union.types = union.types.map(
      (child) => canonicalTypeRef(ctx, child) as any
    );
    union.types = dedupeByRef(union.types);
    union.types.forEach((child) => canonicalizeTypeNode(ctx, child));
    return union;
  }

  if ((canonical as IntersectionType).isIntersectionType?.()) {
    const inter = canonical as IntersectionType;
    if (inter.nominalType)
      inter.nominalType = canonicalTypeRef(
        ctx,
        inter.nominalType
      ) as ObjectType;
    if (inter.structuralType)
      inter.structuralType = canonicalTypeRef(
        ctx,
        inter.structuralType
      ) as ObjectType;
    return inter;
  }

  if ((canonical as TupleType).isTupleType?.()) {
    const tuple = canonical as TupleType;
    tuple.value = tuple.value.map((entry) => canonicalTypeRef(ctx, entry)!);
    tuple.value.forEach((entry) => canonicalizeTypeNode(ctx, entry));
    return tuple;
  }

  if ((canonical as FixedArrayType).isFixedArrayType?.()) {
    const arr = canonical as FixedArrayType;
    if (arr.elemType) arr.elemType = canonicalTypeRef(ctx, arr.elemType);
    if (arr.elemTypeExpr) canonicalizeExpr(ctx, arr.elemTypeExpr);
    return arr;
  }

  if ((canonical as FnType).isFnType?.()) {
    const fn = canonical as FnType;
    if (fn.returnType) fn.returnType = canonicalTypeRef(ctx, fn.returnType);
    fn.parameters.forEach((param) => canonicalizeParameter(ctx, param));
    if (fn.returnTypeExpr) canonicalizeExpr(ctx, fn.returnTypeExpr);
    return fn;
  }

  if ((canonical as ObjectType).isObjectType?.()) {
    const obj = canonical as ObjectType;
    if (obj.parentObjType)
      obj.parentObjType = canonicalTypeRef(
        ctx,
        obj.parentObjType
      ) as ObjectType;
    if (obj.parentObjExpr) canonicalizeExpr(ctx, obj.parentObjExpr);
    if (obj.appliedTypeArgs?.length) {
      obj.appliedTypeArgs = obj.appliedTypeArgs
        .map((arg) => canonicalTypeRef(ctx, arg))
        .filter((arg): arg is Type => !!arg);
    }
    obj.fields.forEach((field) => {
      if (field.type) field.type = canonicalTypeRef(ctx, field.type);
      if (field.typeExpr) canonicalizeExpr(ctx, field.typeExpr);
    });
    obj.implementations = dedupeImplementations(obj.implementations);
    obj.implementations?.forEach((impl) => canonicalizeExpr(ctx, impl));
    if (obj.genericInstances?.length) {
      const canonicalInstances = obj.genericInstances
        .map((inst) => canonicalTypeRef(ctx, inst))
        .filter(
          (inst): inst is ObjectType =>
            !!inst && (inst as ObjectType).isObjectType?.()
        );
      obj.genericInstances = dedupeByRef(canonicalInstances);
    }
    obj.typeParameters?.forEach((param) => canonicalizeExpr(ctx, param));
    return obj;
  }

  if ((canonical as TraitType).isTraitType?.()) {
    const trait = canonical as TraitType;
    if (trait.appliedTypeArgs?.length) {
      trait.appliedTypeArgs = trait.appliedTypeArgs
        .map((arg) => canonicalTypeRef(ctx, arg))
        .filter((arg): arg is Type => !!arg);
    }
    trait.methods.toArray().forEach((method) => canonicalizeExpr(ctx, method));
    trait.implementations = dedupeImplementations(trait.implementations);
    trait.implementations?.forEach((impl) => canonicalizeExpr(ctx, impl));
    if (trait.genericInstances?.length) {
      const canonicalInstances = trait.genericInstances
        .map((inst) => canonicalTypeRef(ctx, inst))
        .filter(
          (inst): inst is TraitType =>
            !!inst && (inst as TraitType).isTraitType?.()
        );
      trait.genericInstances = dedupeByRef(canonicalInstances);
    }
    trait.typeParameters?.forEach((param) => canonicalizeExpr(ctx, param));
    return trait;
  }

  return canonical;
};

export default canonicalizeResolvedTypes;
