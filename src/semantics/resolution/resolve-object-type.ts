import { Call } from "../../syntax-objects/call.js";
import { nop } from "../../syntax-objects/lib/helpers.js";
import { List } from "../../syntax-objects/list.js";
import {
  ObjectType,
  Type,
  TypeAlias,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { getExprType } from "./get-expr-type.js";
import { inferTypeArgs, TypeArgInferencePair } from "./infer-type-args.js";
import { implIsCompatible, resolveImpl } from "./resolve-impl.js";
import { typesAreEqual } from "./types-are-equal.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { canonicalType } from "../types/canonicalize.js";

const PENDING_ALIAS_BINDINGS_KEY = "__voydPendingAliasBindings";

const getAliasEntityFromArg = (typeArg: any): TypeAlias | undefined => {
  if (!typeArg?.isIdentifier?.()) return undefined;
  const resolved = typeArg.resolve?.();
  return resolved?.isTypeAlias?.() ? (resolved as TypeAlias) : undefined;
};

const canonicalizeAppliedAliasArgs = (obj: ObjectType): void => {
  obj.appliedTypeArgs?.forEach((applied) => {
    if (!applied.isTypeAlias?.()) return;
    const aliasArg = applied as TypeAlias;
    const expr = aliasArg.typeExpr;
    const resolved = expr?.isIdentifier?.()
      ? expr.resolve?.()
      : expr?.isTypeAlias?.()
        ? expr
        : undefined;
    if (!resolved?.isTypeAlias?.()) return;
    const alias = resolved as TypeAlias;
    const canonical = alias.typeExpr?.isType?.()
      ? alias.typeExpr
      : alias.type;
    if (canonical) aliasArg.type = canonical;
  });
};

export const canonicalizeAliasUsages = (type?: Type): void => {
  if (!type) return;
  if (type.isObjectType?.()) canonicalizeAppliedAliasArgs(type);
  if (type.isUnionType?.()) type.types.forEach((child) => canonicalizeAliasUsages(child));
  if (type.isIntersectionType?.()) {
    canonicalizeAliasUsages(type.nominalType);
    canonicalizeAliasUsages(type.structuralType);
  }
  if (type.isFixedArrayType?.()) canonicalizeAliasUsages(type.elemType);
  if (type.isFnType?.()) {
    type.parameters.forEach((param) => canonicalizeAliasUsages(param.type));
    canonicalizeAliasUsages(type.returnType);
  }
};

export const registerAliasTypeBinding = (
  typeArg: any,
  placeholder: TypeAlias
): void => {
  const alias = getAliasEntityFromArg(typeArg);
  if (!alias) return;
  resolveTypeExpr(alias);
  const aliasType =
    alias.type ?? (alias.typeExpr?.isType?.() ? alias.typeExpr : undefined);
  if (aliasType) {
    canonicalizeAliasUsages(aliasType);
    placeholder.type = aliasType;
    return;
  }
  const pending =
    alias.getTmpAttribute<TypeAlias[]>(PENDING_ALIAS_BINDINGS_KEY);
  if (pending) {
    if (!pending.includes(placeholder)) pending.push(placeholder);
  } else {
    alias.setTmpAttribute(PENDING_ALIAS_BINDINGS_KEY, [placeholder]);
  }
};

export const finalizeAliasTypeBindings = (alias: TypeAlias): void => {
  const pending =
    alias.getTmpAttribute<TypeAlias[]>(PENDING_ALIAS_BINDINGS_KEY);
  if (!pending?.length || !alias.type) return;
  canonicalizeAliasUsages(alias.type);
  pending.forEach((placeholder) => {
    placeholder.type = alias.type;
  });
  alias.setTmpAttribute(PENDING_ALIAS_BINDINGS_KEY, undefined);
};

export const resolveObjectType = (obj: ObjectType, call?: Call): ObjectType => {
  if (obj.typesResolved) return obj;

  if (obj.typeParameters) {
    return resolveGenericObjVersion(obj, call) ?? obj;
  }

  obj.fields.forEach((field) => {
    field.typeExpr = resolveTypeExpr(field.typeExpr);
    field.type = getExprType(field.typeExpr);
  });

  if (obj.parentObjExpr) {
    obj.parentObjExpr = resolveTypeExpr(obj.parentObjExpr);
    const parentType = getExprType(obj.parentObjExpr);
    obj.parentObjType = parentType?.isObjectType() ? parentType : undefined;
  } else {
    obj.parentObjType = voydBaseObject;
  }

  obj.typesResolved = true;
  return obj;
};

// Detects whether a type-argument expression contains an unresolved type
// identifier (e.g., an unbound generic name like `T`).
export const containsUnresolvedTypeId = (expr: any): boolean => {
  // Follows TypeAlias chains to the underlying resolved type (if any).
  const unwrapAlias = (t: any): any => {
    let cur = t;
    const seen = new Set<any>();
    while (cur && cur.isType?.() && cur.isTypeAlias?.()) {
      if (seen.has(cur)) return undefined; // cycle guard
      seen.add(cur);
      if (!cur.type) return undefined;
      cur = cur.type;
    }
    return cur;
  };

  const stack = [expr];
  while (stack.length) {
    const e = stack.pop();
    if (!e) continue;

    // Unbound generic like `T`
    if (e.isIdentifier?.()) {
      const ty = unwrapAlias(getExprType(e));
      if (!ty) return true;
      continue;
    }

    if (e.isCall?.()) {
      if (e.typeArgs) stack.push(...e.typeArgs.toArray());
      continue;
    }

    if (e.isType?.()) {
      if (e.isObjectType?.()) {
        stack.push(...e.fields.map((f: any) => f.typeExpr));
        continue;
      }
      if (e.isIntersectionType?.()) {
        stack.push(e.nominalTypeExpr?.value, e.structuralTypeExpr?.value);
        continue;
      }
      if (e.isFixedArrayType?.()) {
        stack.push(e.elemTypeExpr);
        continue;
      }
      if (e.isFnType?.()) {
        stack.push(...e.parameters.map((p: any) => p.typeExpr));
        if (e.returnTypeExpr) stack.push(e.returnTypeExpr);
        continue;
      }
    }

    if (e.isList?.()) stack.push(...e.toArray());
  }
  return false;
};

const resolveGenericObjVersion = (
  type: ObjectType,
  call?: Call
): ObjectType | undefined => {
  if (!call) return;

  // If no explicit type args are supplied, try to infer them from the
  // supplied object literal.
  if (!call.typeArgs) {
    const objLiteral = call.argAt(0);
    if (objLiteral?.isObjectLiteral()) {
      const pairs = type.fields
        .map((field) => {
          const initField = objLiteral.fields.find(
            (f) => f.name === field.name
          );
          return initField
            ? { typeExpr: field.typeExpr, argExpr: initField.initializer }
            : undefined;
        })
        .filter((p): p is TypeArgInferencePair => !!p);
      call.typeArgs = inferTypeArgs(type.typeParameters, pairs);
    }
  }

  if (!call.typeArgs) return;

  const hasUnresolved = call.typeArgs
    .toArray()
    .some((arg) => containsUnresolvedTypeId(arg));
  if (hasUnresolved) return;

  // THAR BE DRAGONS HERE. We don't check for multiple existing matches, which means that unions may sometimes overlap.
  const existing = type.genericInstances?.find((c) => typeArgsMatch(call, c));
  if (existing) {
    canonicalizeAppliedAliasArgs(existing);
    return existing;
  }
  return resolveGenericsWithTypeArgs(type, call.typeArgs);
};

const resolveGenericsWithTypeArgs = (
  obj: ObjectType,
  args: List
): ObjectType => {
  const typeParameters = obj.typeParameters!;

  if (args.length !== typeParameters.length) {
    return obj;
  }

  const newObj = obj.clone();
  newObj.typeParameters = undefined;
  newObj.appliedTypeArgs = [];
  newObj.genericParent = obj;

  /** Register resolved type entities for each type param */
  let typesNotResolved = false;
  typeParameters.forEach((typeParam, index) => {
    const typeArg = args.exprAt(index);
    const identifier = typeParam.clone();
    const type = new TypeAlias({
      name: identifier,
      // Preserve the original type arg expression (e.g., MsgPack) for
      // readable formatting of applied generics without expanding recursively.
      typeExpr: typeArg.clone(),
    });
    resolveTypeExpr(typeArg);
    type.type = getExprType(typeArg);
    registerAliasTypeBinding(typeArg, type);
    if (!type.type) typesNotResolved = true;
    newObj.appliedTypeArgs?.push(type);
    newObj.registerEntity(type);
  });
  if (typesNotResolved) return obj;
  obj.registerGenericInstance(newObj);
  const resolvedObj = resolveObjectType(newObj);

  const implementations = newObj.implementations;
  newObj.implementations = []; // Clear implementations to avoid duplicates, resolveImpl will re-add them

  implementations
    .filter((impl) => implIsCompatible(impl, resolvedObj))
    .map((impl) => resolveImpl(impl, resolvedObj));

  canonicalizeAppliedAliasArgs(resolvedObj);
  return resolvedObj;
};

const typeArgsMatch = (call: Call, candidate: ObjectType): boolean =>
  call.typeArgs && candidate.appliedTypeArgs
    ? candidate.appliedTypeArgs.every((t, i) => {
        const argType = getExprType(call.typeArgs?.at(i));
        const appliedType = getExprType(t);
        const canonArg = argType && canonicalType(argType);
        const canonApplied = appliedType && canonicalType(appliedType);
        return typesAreEqual(canonArg, canonApplied);
      })
    : true;
