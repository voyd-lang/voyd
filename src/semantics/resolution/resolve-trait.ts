import { Call } from "../../syntax-objects/call.js";
import { TraitType } from "../../syntax-objects/types/trait.js";
import { TypeAlias } from "../../syntax-objects/types.js";
import { resolveFn } from "./resolve-fn.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { getExprType } from "./get-expr-type.js";
import { typesAreEqual } from "./types-are-equal.js";
import { resolveImpl } from "./resolve-impl.js";
import { canonicalType } from "../types/canonicalize.js";
import {
  internTypeImmediately,
  internTypeWithContext,
} from "../types/type-context.js";

export const resolveTrait = (trait: TraitType, call?: Call): TraitType => {
  if (trait.typeParameters) {
    const resolved = resolveGenericTraitVersion(trait, call) ?? trait;
    return internTypeWithContext(resolved) as TraitType;
  }

  if (trait.typesResolved) return internTypeWithContext(trait) as TraitType;
  trait.methods.applyMap((fn) => resolveFn(fn));
  trait.typesResolved = true;
  return internTypeWithContext(trait) as TraitType;
};

const resolveGenericTraitVersion = (
  trait: TraitType,
  call?: Call
): TraitType | undefined => {
  if (!call?.typeArgs) return;

  const existing = trait.genericInstances?.find((t) =>
    typeArgsMatch(call, t)
  );
  if (existing) return existing;

  const newTrait = trait.clone();
  newTrait.typeParameters = undefined;
  newTrait.appliedTypeArgs = [];
  newTrait.genericParent = trait;

  trait.typeParameters?.forEach((typeParam, index) => {
    const typeArg = call.typeArgs!.exprAt(index);
    const identifier = typeParam.clone();
    const alias = new TypeAlias({ name: identifier, typeExpr: typeArg.clone() });
    alias.parent = newTrait;
    resolveTypeExpr(typeArg);
    alias.type = getExprType(typeArg);
    newTrait.appliedTypeArgs?.push(alias);
    newTrait.registerEntity(alias);
  });

  const canonicalTrait = internTypeImmediately(newTrait) as TraitType;
  const registered = trait.registerGenericInstance(canonicalTrait);
  if (registered !== canonicalTrait) {
    return registered;
  }

  canonicalTrait.methods.applyMap((fn) => resolveFn(fn));
  canonicalTrait.typesResolved = true;
  canonicalTrait.implementations = [];
  trait.implementations.forEach((impl) =>
    resolveImpl(impl.clone(canonicalTrait))
  );

  return canonicalTrait;
};

const typeArgsMatch = (call: Call, candidate: TraitType): boolean =>
  call.typeArgs && candidate.appliedTypeArgs
    ? candidate.appliedTypeArgs.every((t, i) => {
        const argType = getExprType(call.typeArgs!.at(i));
        const appliedType = getExprType(t);
        const canonArg = argType && canonicalType(argType);
        const canonApplied = appliedType && canonicalType(appliedType);
        return typesAreEqual(canonArg, canonApplied);
      })
    : true;
