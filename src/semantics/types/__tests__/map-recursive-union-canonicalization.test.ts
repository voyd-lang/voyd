import { describe, expect, test } from "vitest";
import { parseModule } from "../../../parser/index.js";
import { processSemantics } from "../../index.js";
import { mapRecursiveUnionVoyd } from "../../../__tests__/fixtures/map-recursive-union.js";
import { VoydModule } from "../../../syntax-objects/module.js";
import { Identifier } from "../../../syntax-objects/index.js";
import {
  FixedArrayType,
  FnType,
  IntersectionType,
  ObjectType,
  TupleType,
  Type,
  TypeAlias,
  UnionType,
} from "../../../syntax-objects/types.js";
import { TraitType } from "../../../syntax-objects/types/trait.js";
import { Expr } from "../../../syntax-objects/expr.js";
import { List } from "../../../syntax-objects/list.js";
import { Parameter } from "../../../syntax-objects/parameter.js";
import { Variable } from "../../../syntax-objects/variable.js";
import { ObjectLiteral } from "../../../syntax-objects/object-literal.js";
import { Match, MatchCase } from "../../../syntax-objects/match.js";
import { Implementation } from "../../../syntax-objects/implementation.js";
import { CanonicalTypeTable } from "../canonical-type-table.js";
import { canonicalizeResolvedTypes } from "../canonicalize-resolved-types.js";
import { codegen } from "../../../codegen.js";

const SOME_CONSTRUCTOR_NAME = "Some";
const NONE_CONSTRUCTOR_NAME = "None";

const matchesName = (value: unknown, expected: string): boolean => {
  if (!value) return false;
  if (typeof value === "string") return value === expected;
  if (typeof value === "object") {
    const candidate = value as {
      is?: (input: string) => boolean;
      toString?: () => string;
      value?: string;
    };
    if (typeof candidate.is === "function") return candidate.is(expected);
    if (typeof candidate.value === "string") return candidate.value === expected;
    if (typeof candidate.toString === "function")
      return candidate.toString() === expected;
  }
  return false;
};

const isOptionalSomeConstructor = (obj: ObjectType | undefined): obj is ObjectType =>
  !!obj &&
  !obj.typeParameters?.length &&
  (matchesName(obj.name, SOME_CONSTRUCTOR_NAME) ||
    matchesName(obj.genericParent?.name, SOME_CONSTRUCTOR_NAME));

const isOptionalNoneConstructor = (obj: ObjectType | undefined): obj is ObjectType =>
  !!obj &&
  !obj.typeParameters?.length &&
  (matchesName(obj.name, NONE_CONSTRUCTOR_NAME) ||
    matchesName(obj.genericParent?.name, NONE_CONSTRUCTOR_NAME));

type OptionalScanResult = {
  some: Set<ObjectType>;
  none: Set<ObjectType>;
  unions: Set<UnionType>;
};

const collectOptionalConstructors = (root: Expr): OptionalScanResult => {
  const visitedExpr = new Set<Expr>();
  const visitedTypes = new Set<Type>();
  const some = new Set<ObjectType>();
  const none = new Set<ObjectType>();
  const unions = new Set<UnionType>();

  const visitList = (list?: List): void => {
    if (!list) return;
    list.each((item) => visitExpr(item));
  };

  const visitMatchCase = (caseItem: MatchCase): void => {
    visitType(caseItem.matchType as Type | undefined);
    if (caseItem.matchTypeExpr) visitExpr(caseItem.matchTypeExpr);
    visitExpr(caseItem.expr);
  };

  const visitImplementation = (impl: Implementation): void => {
    visitType(impl.targetType);
    visitType(impl.trait as Type | undefined);
    visitExpr(impl.targetTypeExpr.value);
    visitExpr(impl.body.value);
    visitExpr(impl.traitExpr.value);
    impl.typeParams.toArray().forEach((param) => visitExpr(param));
    impl.exports.forEach((fn) => visitExpr(fn));
    impl.methods.forEach((fn) => visitExpr(fn));
  };

  const visitObjectLiteral = (literal: ObjectLiteral): void => {
    visitType(literal.type);
    literal.fields.forEach((field) => {
      visitType(field.type);
      visitExpr(field.initializer);
    });
  };

  const visitVariable = (variable: Variable): void => {
    visitType(variable.type);
    visitType(variable.originalType);
    visitType(variable.annotatedType);
    visitType(variable.inferredType);
    if (variable.typeExpr) visitExpr(variable.typeExpr);
    visitExpr(variable.initializer);
  };

  const visitParameter = (parameter: Parameter): void => {
    visitType(parameter.type);
    visitType(parameter.originalType);
    if (parameter.typeExpr) visitExpr(parameter.typeExpr);
  };

  const visitType = (type?: Type): void => {
    if (!type || visitedTypes.has(type)) return;
    visitedTypes.add(type);

    if ((type as TypeAlias).isTypeAlias?.()) {
      const alias = type as TypeAlias;
      if (alias.typeExpr) visitExpr(alias.typeExpr);
      visitType(alias.type);
      return;
    }

    if ((type as UnionType).isUnionType?.()) {
      const union = type as UnionType;
      union.types.forEach((child) => visitType(child));
      if (
        union.types.some(
          (candidate) =>
            (candidate as ObjectType).isObjectType?.() &&
            (isOptionalSomeConstructor(candidate as ObjectType) ||
              isOptionalNoneConstructor(candidate as ObjectType))
        )
      ) {
        unions.add(union);
      }
      return;
    }

    if ((type as IntersectionType).isIntersectionType?.()) {
      const inter = type as IntersectionType;
      visitType(inter.nominalType);
      visitType(inter.structuralType);
      if (inter.nominalTypeExpr) visitExpr(inter.nominalTypeExpr.value);
      if (inter.structuralTypeExpr) visitExpr(inter.structuralTypeExpr.value);
      return;
    }

    if ((type as TupleType).isTupleType?.()) {
      const tuple = type as TupleType;
      tuple.value.forEach((entry) => visitType(entry));
      return;
    }

    if ((type as FixedArrayType).isFixedArrayType?.()) {
      const arr = type as FixedArrayType;
      visitType(arr.elemType);
      visitExpr(arr.elemTypeExpr);
      return;
    }

    if ((type as FnType).isFnType?.()) {
      const fn = type as FnType;
      visitType(fn.returnType);
      fn.parameters.forEach((param) => visitParameter(param));
      if (fn.returnTypeExpr) visitExpr(fn.returnTypeExpr);
      return;
    }

    if ((type as ObjectType).isObjectType?.()) {
      const obj = type as ObjectType;
      if (isOptionalSomeConstructor(obj)) some.add(obj);
      if (isOptionalNoneConstructor(obj)) none.add(obj);
      visitType(obj.parentObjType);
      if (obj.parentObjExpr) visitExpr(obj.parentObjExpr);
      obj.appliedTypeArgs?.forEach((arg) => visitType(arg));
      obj.fields.forEach((field) => visitType(field.type));
      obj.genericInstances?.forEach((inst) => visitType(inst));
      if (obj.genericParent) visitType(obj.genericParent);
      obj.typeParameters?.forEach((param) => visitExpr(param));
      obj.implementations?.forEach((impl) => visitExpr(impl));
      return;
    }

    if ((type as TraitType).isTraitType?.()) {
      const trait = type as TraitType;
      trait.appliedTypeArgs?.forEach((arg) => visitType(arg));
      trait.genericInstances?.forEach((inst) => visitType(inst));
      if (trait.genericParent) visitType(trait.genericParent);
      trait.methods.toArray().forEach((method) => visitExpr(method));
      trait.implementations?.forEach((impl) => visitExpr(impl));
      trait.typeParameters?.forEach((param) => visitExpr(param));
    }
  };

  const visitExpr = (expr?: Expr): void => {
    if (!expr || visitedExpr.has(expr)) return;
    visitedExpr.add(expr);

    if (expr.isModule()) {
      expr.each((child) => visitExpr(child));
      return;
    }

    if (expr.isFn()) {
      visitType(expr.returnType);
      visitType(expr.inferredReturnType);
      visitType(expr.annotatedReturnType);
      expr.appliedTypeArgs?.forEach((arg) => visitType(arg));
      expr.parameters.forEach((param) => visitParameter(param));
      expr.variables.forEach((variable) => visitVariable(variable));
      expr.typeParameters?.forEach((param) => visitExpr(param));
      expr.genericInstances?.forEach((inst) => visitExpr(inst));
      visitExpr(expr.body ?? undefined);
      if (expr.returnTypeExpr) visitExpr(expr.returnTypeExpr);
      return;
    }

    if (expr.isClosure()) {
      visitType(expr.returnType);
      visitType(expr.inferredReturnType);
      visitType(expr.annotatedReturnType);
      expr.parameters.forEach((param) => visitParameter(param));
      expr.variables.forEach((variable) => visitVariable(variable));
      expr.captures.forEach((capture) => visitExpr(capture));
      if (expr.returnTypeExpr) visitExpr(expr.returnTypeExpr);
      visitExpr(expr.body);
      return;
    }

    if (expr.isVariable()) {
      visitVariable(expr);
      return;
    }

    if (expr.isParameter()) {
      visitParameter(expr);
      return;
    }

    if (expr.isBlock()) {
      visitType(expr.type);
      expr.body.forEach((child) => visitExpr(child));
      return;
    }

    if (expr.isCall()) {
      visitType(expr.type);
      visitExpr(expr.fnName);
      visitList(expr.args);
      visitList(expr.typeArgs ?? undefined);
      const fn = expr.fn;
      if (fn) {
        if (fn.isFn?.()) visitExpr(fn as unknown as Expr);
        if ((fn as ObjectType).isObjectType?.()) visitType(fn as ObjectType);
      }
      return;
    }

    if (expr.isObjectLiteral()) {
      visitObjectLiteral(expr);
      return;
    }

    if (expr.isArrayLiteral()) {
      expr.elements.forEach((element) => visitExpr(element));
      return;
    }

    if (expr.isMatch()) {
      visitType(expr.type);
      visitType(expr.baseType);
      visitExpr(expr.operand);
      if (expr.bindVariable) visitVariable(expr.bindVariable);
      visitExpr(expr.bindIdentifier);
      expr.cases.forEach((caseItem) => visitMatchCase(caseItem));
      if (expr.defaultCase) visitMatchCase(expr.defaultCase);
      return;
    }

    if (expr.isImpl()) {
      visitImplementation(expr);
      return;
    }

    if (expr.isDeclaration()) {
      expr.fns.forEach((fn) => visitExpr(fn));
      return;
    }

    if (expr.isGlobal()) {
      visitType(expr.type);
      visitExpr(expr.initializer);
      return;
    }

    if (expr.isTrait()) {
      visitType(expr);
      return;
    }

    if (expr.isType()) {
      visitType(expr);
      return;
    }

    if (expr.isIdentifier()) {
      visitType(expr.type);
      return;
    }

    if (expr.isList()) {
      visitList(expr);
    }
  };

  visitExpr(root);
  return { some, none, unions };
};

describe("map-recursive-union optional constructor canonicalization", () => {
  test("reuses canonical Some/None instances across generics", async () => {
    const parsed = await parseModule(mapRecursiveUnionVoyd);
    const canonicalRoot = processSemantics(parsed) as VoydModule;
    const srcModule = canonicalRoot.resolveModule(Identifier.from("src")) as
      | VoydModule
      | undefined;
    expect(srcModule).toBeDefined();

    const { some, none, unions } = collectOptionalConstructors(
      srcModule ?? canonicalRoot
    );

    const recAlias = srcModule?.resolveEntity(Identifier.from("RecType")) as
      | TypeAlias
      | undefined;
    expect(recAlias?.type?.isUnionType?.()).toBe(true);

    const recUnion = recAlias?.type as UnionType;
    const recOptional = [...unions].find((union) =>
      union.types.some((candidate) => {
        if (!(candidate as ObjectType).isObjectType?.()) return false;
        const obj = candidate as ObjectType;
        return (
          isOptionalSomeConstructor(obj) && obj.appliedTypeArgs?.[0] === recUnion
        );
      })
    );

    expect(recOptional).toBeDefined();

    const recSomeVariant = recOptional?.types.find(
      (candidate) =>
        (candidate as ObjectType).isObjectType?.() &&
        isOptionalSomeConstructor(candidate as ObjectType)
    ) as ObjectType | undefined;
    const recNoneVariant = recOptional?.types.find(
      (candidate) =>
        (candidate as ObjectType).isObjectType?.() &&
        isOptionalNoneConstructor(candidate as ObjectType)
    ) as ObjectType | undefined;

    expect(recSomeVariant?.appliedTypeArgs?.[0]).toBe(recUnion);
    expect(recNoneVariant).toBeDefined();

    const someBase = recSomeVariant?.genericParent;
    const recSomeInstances = (someBase?.genericInstances ?? []).filter(
      (candidate) => candidate.appliedTypeArgs?.[0] === recUnion
    );
    expect(recSomeInstances).toHaveLength(1);
    expect(recSomeInstances[0]).toBe(recSomeVariant);

    const recNoneInstances = [...none].filter(
      (candidate) => candidate === recNoneVariant
    );
    expect(recNoneInstances).toHaveLength(1);

    const debugTable = new CanonicalTypeTable({ recordEvents: true });
    canonicalizeResolvedTypes(srcModule ?? canonicalRoot, { table: debugTable });
    const optionalDedupeEvents = debugTable
      .getDedupeEvents()
      .filter((event) => {
        const canonical = event.canonical as ObjectType;
        if (!canonical?.isObjectType?.()) return false;
        const reused = event.reused as ObjectType;
        if (reused?.lexicon !== canonical.lexicon) return false;
        return (
          isOptionalSomeConstructor(canonical) ||
          isOptionalNoneConstructor(canonical)
        );
      });
    expect(optionalDedupeEvents).toHaveLength(0);
  });

  test("optional constructors keep Binaryen caches after codegen", async () => {
    const parsed = await parseModule(mapRecursiveUnionVoyd);
    const canonicalRoot = processSemantics(parsed) as VoydModule;
    const module = codegen(canonicalRoot);

    try {
      const srcModule = canonicalRoot.resolveModule(Identifier.from("src")) as
        | VoydModule
        | undefined;
      expect(srcModule).toBeDefined();

      const { some, none, unions } = collectOptionalConstructors(
        srcModule ?? canonicalRoot
      );

      const recAlias = srcModule?.resolveEntity(Identifier.from("RecType")) as
        | TypeAlias
        | undefined;
      expect(recAlias?.type?.isUnionType?.()).toBe(true);

      const recUnion = recAlias?.type as UnionType;
      const recOptional = [...unions].find((union) =>
        union.types.some((candidate) => {
          if (!(candidate as ObjectType).isObjectType?.()) return false;
          const obj = candidate as ObjectType;
          return (
            isOptionalSomeConstructor(obj) &&
            obj.appliedTypeArgs?.[0] === recUnion
          );
        })
      );
      expect(recOptional).toBeDefined();

      const recSomeVariant = recOptional?.types.find(
        (candidate) =>
          (candidate as ObjectType).isObjectType?.() &&
          isOptionalSomeConstructor(candidate as ObjectType)
      ) as ObjectType | undefined;
      const recNoneVariant = recOptional?.types.find(
        (candidate) =>
          (candidate as ObjectType).isObjectType?.() &&
          isOptionalNoneConstructor(candidate as ObjectType)
      ) as ObjectType | undefined;

      expect(recSomeVariant).toBeDefined();
      expect(recNoneVariant).toBeDefined();

      const recSomeInstances = [...some].filter(
        (candidate) => candidate === recSomeVariant
      );
      const recNoneInstances = [...none].filter(
        (candidate) => candidate === recNoneVariant
      );
      expect(recSomeInstances).toHaveLength(1);
      expect(recNoneInstances).toHaveLength(1);

      expect(recSomeVariant?.binaryenType).not.toBeUndefined();
      expect(recNoneVariant?.binaryenType).not.toBeUndefined();
    } finally {
      module.dispose();
    }
  });
});
