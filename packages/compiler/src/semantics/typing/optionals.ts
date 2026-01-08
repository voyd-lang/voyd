import type { TypeId } from "../ids.js";
import type { TypeArena } from "./type-arena.js";
import type { TypingContext, TypingResult } from "./types.js";

export type OptionalInfo = {
  optionalType: TypeId;
  innerType: TypeId;
  someType: TypeId;
  noneType: TypeId;
};

export type OptionalResolverContext = {
  arena: TypeArena;
  unknownType: TypeId;
  getObjectStructuralTypeId?: (nominal: TypeId) => TypeId | undefined;
};

const cacheByArena = new WeakMap<TypeArena, Map<TypeId, OptionalInfo | null>>();

export const optionalResolverContextForTypingContext = (
  ctx: TypingContext
): OptionalResolverContext => ({
  arena: ctx.arena,
  unknownType: ctx.primitives.unknown,
  getObjectStructuralTypeId: (nominal) =>
    ctx.objects.getInstanceByNominal(nominal)?.structural,
});

export const optionalResolverContextForTypingResult = (
  typing: TypingResult
): OptionalResolverContext => ({
  arena: typing.arena,
  unknownType: typing.primitives.unknown,
  getObjectStructuralTypeId: (nominal) =>
    typing.objectsByNominal.get(nominal)?.structural,
});

const resolveStructuralTypeId = (
  type: TypeId,
  ctx: OptionalResolverContext
): TypeId | undefined => {
  if (type === ctx.unknownType) {
    return undefined;
  }

  const desc = ctx.arena.get(type);
  if (desc.kind === "structural-object") {
    return type;
  }
  if (desc.kind === "intersection") {
    if (typeof desc.structural === "number") {
      return desc.structural;
    }
    if (
      typeof desc.nominal === "number" &&
      ctx.getObjectStructuralTypeId
    ) {
      return ctx.getObjectStructuralTypeId(desc.nominal);
    }
    return undefined;
  }
  if (desc.kind === "nominal-object" && ctx.getObjectStructuralTypeId) {
    return ctx.getObjectStructuralTypeId(type);
  }
  return undefined;
};

export const getOptionalInfo = (
  type: TypeId,
  ctx: OptionalResolverContext
): OptionalInfo | undefined => {
  const cache = (() => {
    const existing = cacheByArena.get(ctx.arena);
    if (existing) {
      return existing;
    }
    const created = new Map<TypeId, OptionalInfo | null>();
    cacheByArena.set(ctx.arena, created);
    return created;
  })();

  const cached = cache.get(type);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const desc = ctx.arena.get(type);
  if (desc.kind !== "union" || desc.members.length !== 2) {
    cache.set(type, null);
    return undefined;
  }

  const [a, b] = desc.members;
  if (typeof a !== "number" || typeof b !== "number") {
    cache.set(type, null);
    return undefined;
  }

  const analyzeMember = (
    member: TypeId
  ): { kind: "none" } | { kind: "some"; innerType: TypeId } | undefined => {
    const structural = resolveStructuralTypeId(member, ctx);
    if (typeof structural !== "number") {
      return undefined;
    }
    const structuralDesc = ctx.arena.get(structural);
    if (structuralDesc.kind !== "structural-object") {
      return undefined;
    }
    if (structuralDesc.fields.length === 0) {
      return { kind: "none" };
    }
    if (
      structuralDesc.fields.length === 1 &&
      structuralDesc.fields[0]!.name === "value"
    ) {
      return { kind: "some", innerType: structuralDesc.fields[0]!.type };
    }
    return undefined;
  };

  const analyzedA = analyzeMember(a);
  const analyzedB = analyzeMember(b);

  const info = (() => {
    if (analyzedA?.kind === "some" && analyzedB?.kind === "none") {
      return {
        optionalType: type,
        innerType: analyzedA.innerType,
        someType: a,
        noneType: b,
      } satisfies OptionalInfo;
    }
    if (analyzedA?.kind === "none" && analyzedB?.kind === "some") {
      return {
        optionalType: type,
        innerType: analyzedB.innerType,
        someType: b,
        noneType: a,
      } satisfies OptionalInfo;
    }
    return undefined;
  })();

  cache.set(type, info ?? null);
  return info;
};

export const isOptionalType = (
  type: TypeId,
  ctx: OptionalResolverContext
): boolean => Boolean(getOptionalInfo(type, ctx));

export const optionalInnerType = (
  type: TypeId,
  ctx: OptionalResolverContext
): TypeId | undefined => getOptionalInfo(type, ctx)?.innerType;

