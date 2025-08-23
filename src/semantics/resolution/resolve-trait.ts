import { Call } from "../../syntax-objects/call.js";
import { nop } from "../../syntax-objects/lib/helpers.js";
import { TraitType } from "../../syntax-objects/types/trait.js";
import { TypeAlias } from "../../syntax-objects/types.js";
import { resolveFn } from "./resolve-fn.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { getExprType } from "./get-expr-type.js";
import { typesAreEqual } from "./types-are-equal.js";
import { resolveImpl } from "./resolve-impl.js";

export const resolveTrait = (trait: TraitType, call?: Call): TraitType => {
  if (trait.typeParameters) {
    return resolveGenericTraitVersion(trait, call) ?? trait;
  }

  if (trait.typesResolved) return trait;
  trait.methods.applyMap((fn) => resolveFn(fn));
  trait.typesResolved = true;
  return trait;
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
    const alias = new TypeAlias({ name: identifier, typeExpr: nop() });
    alias.parent = newTrait;
    resolveTypeExpr(typeArg);
    alias.type = getExprType(typeArg);
    newTrait.appliedTypeArgs?.push(alias);
    newTrait.registerEntity(alias);
  });

  trait.registerGenericInstance(newTrait);
  // Resolve methods for the new trait
  newTrait.methods.applyMap((fn) => resolveFn(fn));
  newTrait.typesResolved = true;
  // Clear implementations, resolveImpl will re-add as needed
  newTrait.implementations = [];
  trait.implementations.forEach((impl) =>
    resolveImpl(impl.clone(newTrait))
  );

  return newTrait;
};

const typeArgsMatch = (call: Call, candidate: TraitType): boolean =>
  call.typeArgs && candidate.appliedTypeArgs
    ? candidate.appliedTypeArgs.every((t, i) =>
        typesAreEqual(getExprType(call.typeArgs!.at(i)), getExprType(t))
      )
    : true;
