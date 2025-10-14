import { Call } from "../../syntax-objects/call.js";
import { Expr } from "../../syntax-objects/expr.js";
import { nop } from "../../syntax-objects/lib/helpers.js";
import { List } from "../../syntax-objects/list.js";
import {
  ObjectType,
  Type,
  TypeAlias,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { getExprType } from "./get-expr-type.js";
import { inferTypeArgs, TypeArgInferencePair } from "./infer-type-args.js";
import { implIsCompatible, resolveImpl } from "./resolve-impl.js";
import { typesAreEqual } from "./types-are-equal.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { canonicalType } from "../types/canonicalize.js";
import {
  internTypeImmediately,
  internTypeWithContext,
} from "../types/type-context.js";

export const resolveObjectType = (obj: ObjectType, call?: Call): ObjectType => {
  if (obj.typesResolved) return internTypeWithContext(obj) as ObjectType;

  if (obj.typeParameters) {
    const resolved = resolveGenericObjVersion(obj, call) ?? obj;
    return internTypeWithContext(resolved) as ObjectType;
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
  return internTypeWithContext(obj) as ObjectType;
};

export const containsUnresolvedTypeId = (
  expr: any,
  allowed: Set<string> = new Set()
): boolean => {
  const unwrapAlias = (t: any): any => {
    let cur = t;
    const seen = new Set<any>();
    while (cur && cur.isType?.() && cur.isTypeAlias?.()) {
      if (seen.has(cur)) return undefined;
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

    if (e.isIdentifier?.()) {
      if (allowed.has(e.value)) continue;
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

  if (!call.typeArgs) {
    const expected = call.getAttribute("expectedType") as Type | undefined;
    if (expected?.isObjectType?.() && expected.appliedTypeArgs?.length) {
      const synthesized = expected.appliedTypeArgs
        .map((arg) => {
          if ((arg as TypeAlias).isTypeAlias?.()) {
            const alias = arg as TypeAlias;
            const identifier = Identifier.from(alias.name.toString());
            identifier.parent = call;
            return resolveTypeExpr(identifier);
          }
          return undefined;
        })
        .filter((expr): expr is Expr => !!expr);
      if (synthesized.length === expected.appliedTypeArgs.length) {
        call.typeArgs = new List({ value: synthesized });
      }
    }
  }

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

  const existing = type.genericInstances?.find((c) => typeArgsMatch(call, c));
  if (existing) return existing;
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

  let typesNotResolved = false;
  typeParameters.forEach((typeParam, index) => {
    const typeArg = args.exprAt(index);
    const identifier = typeParam.clone();
    const type = new TypeAlias({
      name: identifier,
      typeExpr: typeArg.clone(),
    });
    resolveTypeExpr(typeArg);
    const resolvedType = getExprType(typeArg);
    if (resolvedType) {
      type.type = resolvedType;
    } else if (typeArg.isIdentifier?.()) {
      const resolvedAlias = typeArg.resolve?.();
      if (resolvedAlias?.isTypeAlias?.() && resolvedAlias.type) {
        type.type = resolvedAlias.type;
      }
    }
    if (!type.type) typesNotResolved = true;
    newObj.appliedTypeArgs?.push(type);
    newObj.registerEntity(type);
  });
  if (typesNotResolved) return obj;
  const implementations = newObj.implementations;
  newObj.implementations = [];

  const canonicalInstance = internTypeImmediately(newObj) as ObjectType;
  const registered = obj.registerGenericInstance(canonicalInstance);
  const resolvedObj = resolveObjectType(registered);

  if (registered !== canonicalInstance) {
    return resolvedObj;
  }

  implementations
    .filter((impl) => implIsCompatible(impl, resolvedObj))
    .map((impl) => resolveImpl(impl, resolvedObj));

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
