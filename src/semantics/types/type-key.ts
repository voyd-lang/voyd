import {
  FixedArrayType,
  FnType,
  IntersectionType,
  ObjectType,
  PrimitiveType,
  SelfType,
  TupleType,
  Type,
  TypeAlias,
  UnionType,
} from "../../syntax-objects/types.js";
import { Expr } from "../../syntax-objects/expr.js";
import { getExprType } from "../resolution/get-expr-type.js";
import { resolveTypeExpr } from "../resolution/resolve-type-expr.js";
import { TraitType } from "../../syntax-objects/types/trait.js";

type TypeKeyContext = {
  memo: Map<Type, string>;
  stack: Map<Type, string>;
  nextCycle: number;
};

const createContext = (): TypeKeyContext => ({
  memo: new Map(),
  stack: new Map(),
  nextCycle: 0,
});

const computeKey = (type: Type, ctx: TypeKeyContext): string => {
  if (ctx.memo.has(type)) return ctx.memo.get(type)!;

  const cycleId = ctx.stack.get(type);
  if (cycleId) {
    if ((type as TypeAlias).isTypeAlias?.()) {
      const alias = type as TypeAlias;
      return `alias-cycle:${alias.name.value}`;
    }
    if ((type as UnionType).isUnionType?.()) {
      const union = type as UnionType;
      return `union-cycle:${union.name.value}`;
    }
    return `cycle:${cycleId}`;
  }

  if ((type as TypeAlias).isTypeAlias?.()) {
    const alias = type as TypeAlias;
    const target = alias.type;
    if (target) return computeKey(target, ctx);
    return `alias:${alias.name.value}`;
  }

  const currentCycle = `${ctx.nextCycle++}`;
  ctx.stack.set(type, currentCycle);

  const keyFor = (resolved?: Type, expr?: Expr): string => {
    if (resolved) return computeKey(resolved, ctx);
    if (!expr) return "unknown";
    const resolvedExpr = resolveTypeExpr(expr);
    const resolvedType = getExprType(resolvedExpr);
    return resolvedType ? computeKey(resolvedType, ctx) : "unknown";
  };

  let key: string;
  if ((type as UnionType).isUnionType?.()) {
    const union = type as UnionType;
    const parts = union.types.map((child) => {
      const childKey = computeKey(child, ctx);
      return childKey.startsWith("union{")
        ? `union-cycle:${union.name.value}`
        : childKey;
    });
    const unique = Array.from(new Set(parts)).sort();
    key = `union{${unique.join("|")}}`;
  } else if ((type as IntersectionType).isIntersectionType?.()) {
    const inter = type as IntersectionType;
    const parts: string[] = [];
    if (inter.nominalType) parts.push(computeKey(inter.nominalType, ctx));
    if (inter.structuralType) parts.push(computeKey(inter.structuralType, ctx));
    const unique = Array.from(new Set(parts)).sort();
    key = `intersection{${unique.join("&")}}`;
  } else if ((type as TupleType).isTupleType?.()) {
    const tuple = type as TupleType;
    key = `tuple[${tuple.value
      .map((entry) => computeKey(entry, ctx))
      .join(",")}]`;
  } else if ((type as FixedArrayType).isFixedArrayType?.()) {
    const arr = type as FixedArrayType;
    key = `fixed[${keyFor(arr.elemType, arr.elemTypeExpr)}]`;
  } else if ((type as FnType).isFnType?.()) {
    const fn = type as FnType;
    const params = fn.parameters.map((param) => {
      const paramKey = keyFor(param.type, param.typeExpr);
      return param.isOptional ? `?${paramKey}` : paramKey;
    });
    const retKey = keyFor(fn.returnType, fn.returnTypeExpr);
    key = `fn(${params.join(",")})=>${retKey}`;
  } else if ((type as ObjectType).isObjectType?.()) {
    const obj = type as ObjectType;
    if (obj.isStructural) {
      const fieldKeys = obj.fields
        .map((field) => {
          return `${field.name}:${keyFor(field.type, field.typeExpr)}`;
        })
        .sort();
      const parentKey = obj.parentObjType
        ? `|extends:${computeKey(obj.parentObjType, ctx)}`
        : "";
      key = `struct{${fieldKeys.join(",")}${parentKey}}`;
    } else {
      const baseId = obj.genericParent ? obj.genericParent.idNum : obj.idNum;
      const applied = obj.appliedTypeArgs?.length
        ? `<${obj.appliedTypeArgs
            .map((arg) => {
              const argKey = computeKey(arg, ctx);
              if (argKey.startsWith("union{")) {
                return `union-cycle:${(arg as UnionType).name.value}`;
              }
              return argKey;
            })
            .join(",")}>`
        : "";
      const parentKey = obj.parentObjType
        ? `:parent=${computeKey(obj.parentObjType, ctx)}`
        : "";
      key = `object#${baseId}${parentKey}${applied}`;
    }
  } else if ((type as TraitType).isTraitType?.()) {
    const trait = type as TraitType;
    const baseId = trait.genericParent
      ? trait.genericParent.idNum
      : trait.idNum;
    const applied = trait.appliedTypeArgs?.length
      ? `<${trait.appliedTypeArgs
          .map((arg) => computeKey(arg, ctx))
          .join(",")}>`
      : "";
    key = `trait#${baseId}${applied}`;
  } else if ((type as PrimitiveType).isPrimitiveType?.()) {
    key = `primitive:${type.name.value}`;
  } else if ((type as SelfType).isSelfType?.()) {
    key = "self";
  } else {
    key = `${type.kindOfType ?? "type"}#${type.idNum ?? type.id ?? "anon"}`;
  }

  ctx.stack.delete(type);
  ctx.memo.set(type, key);
  return key;
};

export const typeKey = (type: Type): string => {
  const ctx = createContext();
  return computeKey(type, ctx);
};

export default typeKey;
