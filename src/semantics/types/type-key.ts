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
import { VoydModule } from "../../syntax-objects/module.js";

type StackFrame = {
  type: Type;
  cycleId: string;
  depth: number;
};

type TypeKeyContext = {
  memo: Map<Type, string>;
  stack: Map<Type, StackFrame>;
  frames: StackFrame[];
  depths: Map<Type, number>;
};

const createContext = (): TypeKeyContext => ({
  memo: new Map(),
  stack: new Map(),
  frames: [],
  depths: new Map(),
});

const computeKey = (type: Type, ctx: TypeKeyContext): string => {
  const memoized = ctx.memo.get(type);
  if (memoized) return memoized;

  const inProgress = ctx.stack.get(type);
  if (inProgress) {
    return buildCycleMarker(type, inProgress);
  }

  if ((type as TypeAlias).isTypeAlias?.()) {
    const alias = type as TypeAlias;
    const frame = pushFrame(ctx, alias);
    const target = alias.type;
    const key = target
      ? computeKey(target, ctx)
      : `alias:${alias.name.toString()}`;
    ctx.memo.set(alias, key);
    popFrame(ctx, frame);
    return key;
  }

  const frame = pushFrame(ctx, type);
  let key: string;

  if ((type as UnionType).isUnionType?.()) {
    const union = type as UnionType;
    const parts = union.types.map((child) => computeKey(child, ctx));
    const unique = Array.from(new Set(parts)).sort();
    key = `union{${unique.join("|")}}`;
  } else if ((type as IntersectionType).isIntersectionType?.()) {
    const inter = type as IntersectionType;
    const parts: string[] = [];
    if (inter.nominalType) parts.push(computeKey(inter.nominalType, ctx));
    if (inter.structuralType)
      parts.push(computeKey(inter.structuralType, ctx));
    const unique = Array.from(new Set(parts)).sort();
    key = `intersection{${unique.join("&")}}`;
  } else if ((type as TupleType).isTupleType?.()) {
    const tuple = type as TupleType;
    key = `tuple[${tuple.value
      .map((entry) => computeKey(entry, ctx))
      .join(",")}]`;
  } else if ((type as FixedArrayType).isFixedArrayType?.()) {
    const arr = type as FixedArrayType;
    key = `fixed[${keyFor(ctx, arr.elemType, arr.elemTypeExpr)}]`;
  } else if ((type as FnType).isFnType?.()) {
    const fn = type as FnType;
    const params = fn.parameters.map((param) => {
      const paramKey = keyFor(ctx, param.type, param.typeExpr);
      return param.isOptional ? `?${paramKey}` : paramKey;
    });
    const retKey = keyFor(ctx, fn.returnType, fn.returnTypeExpr);
    key = `fn(${params.join(",")})=>${retKey}`;
  } else if ((type as ObjectType).isObjectType?.()) {
    const obj = type as ObjectType;
    if (obj.isStructural) {
      const fieldKeys = obj.fields
        .map((field) => {
          return `${field.name}:${keyFor(ctx, field.type, field.typeExpr)}`;
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
            .map((arg) =>
              normalizeUnionArgKey(ctx, arg, computeKey(arg, ctx))
            )
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
    key = `${type.kindOfType ?? "type"}#${type.idNum ?? (type as any).id ?? "anon"}`;
  }

  ctx.memo.set(type, key);
  popFrame(ctx, frame);
  return key;
};

const keyFor = (
  ctx: TypeKeyContext,
  resolved?: Type,
  expr?: Expr
): string => {
  if (resolved) return computeKey(resolved, ctx);
  if (!expr) return "unknown";
  const resolvedExpr = resolveTypeExpr(expr);
  const resolvedType = getExprType(resolvedExpr);
  return resolvedType ? computeKey(resolvedType, ctx) : "unknown";
};

const pushFrame = (ctx: TypeKeyContext, type: Type): StackFrame => {
  const currentDepth = ctx.depths.get(type) ?? 0;
  ctx.depths.set(type, currentDepth + 1);

  const frame: StackFrame = {
    type,
    cycleId: `${currentDepth}`,
    depth: currentDepth,
  };
  ctx.stack.set(type, frame);
  ctx.frames.push(frame);
  return frame;
};

const popFrame = (ctx: TypeKeyContext, frame: StackFrame): void => {
  const last = ctx.frames.pop();
  if (last && last.type !== frame.type) {
    throw new Error("typeKey stack invariant violated");
  }
  ctx.stack.delete(frame.type);
  const depth = ctx.depths.get(frame.type);
  if (depth !== undefined) {
    if (depth <= 1) {
      ctx.depths.delete(frame.type);
    } else {
      ctx.depths.set(frame.type, depth - 1);
    }
  }
};

const buildCycleMarker = (type: Type, frame: StackFrame): string => {
  const depthSuffix = `@${frame.depth}`;
  const cycleSuffix = `#${frame.cycleId}`;

  if ((type as TypeAlias).isTypeAlias?.()) {
    const alias = type as TypeAlias;
    return `alias-cycle:${stableAliasId(alias)}${cycleSuffix}${depthSuffix}`;
  }

  if ((type as UnionType).isUnionType?.()) {
    const union = type as UnionType;
    return `union-cycle:${stableUnionId(union)}${cycleSuffix}${depthSuffix}`;
  }

  return `cycle:${stableTypeToken(type)}${cycleSuffix}${depthSuffix}`;
};

const stableAliasId = (alias: TypeAlias): string => {
  const modulePath = modulePathFor(alias.parentModule);
  const name = alias.name.toString();
  return modulePath ? `${modulePath}::${name}` : name;
};

const stableUnionId = (union: UnionType): string => {
  const aliasParent = (union.parent as TypeAlias | undefined)?.isTypeAlias?.()
    ? (union.parent as TypeAlias)
    : undefined;
  const modulePath = modulePathFor(union.parentModule);
  const name =
    aliasParent?.name?.toString?.() ??
    union.name?.toString?.() ??
    union.name?.value ??
    `${union.kindOfType ?? "union"}#${union.idNum}`;

  if (aliasParent) {
    return stableAliasId(aliasParent);
  }

  return modulePath ? `${modulePath}::${name}` : name;
};

const modulePathFor = (module?: VoydModule): string | undefined => {
  if (!module) return undefined;
  const path = module.getPath();
  if (!path.length) return undefined;
  const filtered = module.isRoot ? path.slice(1) : path;
  return filtered.length ? filtered.join("::") : undefined;
};

const stableTypeToken = (type: Type): string => {
  if ((type as any).name?.toString) {
    return (type as any).name.toString();
  }
  if ((type as any).name?.value) {
    return (type as any).name.value;
  }
  return `${type.kindOfType ?? "type"}#${type.idNum ?? (type as any).id ?? "anon"}`;
};

const normalizeUnionArgKey = (
  ctx: TypeKeyContext,
  arg: Type,
  argKey: string
): string => {
  if (
    argKey.startsWith("alias-cycle:") ||
    argKey.startsWith("union-cycle:")
  ) {
    return argKey;
  }

  if ((arg as UnionType).isUnionType?.() && argKey.startsWith("union{")) {
    const union = arg as UnionType;
    return `union-cycle:${stableUnionId(union)}${cycleSuffixForFallback(
      ctx,
      union
    )}`;
  }

  return argKey;
};

const cycleSuffixForFallback = (
  ctx: TypeKeyContext,
  union: UnionType
): string => {
  const activeFrame = ctx.stack.get(union);
  if (activeFrame) {
    return `#${activeFrame.cycleId}@${activeFrame.depth}`;
  }

  const nearestUnion = [...ctx.frames]
    .reverse()
    .find((frame) => (frame.type as UnionType).isUnionType?.());

  if (nearestUnion) {
    return `#${nearestUnion.cycleId}@${nearestUnion.depth}`;
  }

  return "#0@0";
};

export const typeKey = (type: Type): string => {
  const ctx = createContext();
  return computeKey(type, ctx);
};

export default typeKey;
