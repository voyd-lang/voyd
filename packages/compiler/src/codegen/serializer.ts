import type { CodegenContext } from "./context.js";
import type { SerializerMetadata } from "../semantics/symbol-index.js";
import type { HirTypeExpr } from "../semantics/hir/index.js";
import type { TypeId } from "../semantics/ids.js";

export const findSerializerForType = (
  typeId: TypeId,
  ctx: CodegenContext
): SerializerMetadata | undefined => {
  const serializers: SerializerMetadata[] = [];
  collectSerializersForType({ typeId, ctx, serializers, seen: new Set() });
  return selectSerializerForType(typeId, serializers);
};

export const findUnambiguousSerializerForType = (
  typeId: TypeId,
  ctx: CodegenContext,
): SerializerMetadata | undefined => {
  const serializers: SerializerMetadata[] = [];
  collectSerializersForType({ typeId, ctx, serializers, seen: new Set() });
  if (serializers.length === 0) {
    return undefined;
  }

  const reference = serializers[0]!;
  const mismatch = serializers.find((serializer) => !sameSerializer(serializer, reference));
  return mismatch ? undefined : reference;
};

export const findSerializerFormatForType = (
  typeId: TypeId,
  ctx: CodegenContext,
): string | undefined => {
  const serializers: SerializerMetadata[] = [];
  collectSerializersForType({ typeId, ctx, serializers, seen: new Set() });
  if (serializers.length === 0) {
    return undefined;
  }

  const formatId = serializers[0]!.formatId;
  const mismatch = serializers.find((serializer) => serializer.formatId !== formatId);
  if (mismatch) {
    throw new Error(`conflicting serializer formats for type ${typeId}`);
  }
  return formatId;
};

const selectSerializerForType = (
  typeId: TypeId,
  serializers: readonly SerializerMetadata[]
): SerializerMetadata | undefined => {
  if (serializers.length === 0) {
    return undefined;
  }

  const reference = serializers[0]!;
  const mismatch = serializers.find((serializer) => !sameSerializer(serializer, reference));
  if (mismatch) {
    throw new Error(`conflicting serializers for type ${typeId}`);
  }
  return reference;
};

export const findSerializerForDeclaredType = (
  typeExpr: HirTypeExpr | undefined,
  ctx: CodegenContext,
): SerializerMetadata | undefined => {
  if (!typeExpr || typeExpr.typeKind !== "named") {
    return undefined;
  }
  if (typeof typeExpr.symbol !== "number") {
    return undefined;
  }
  return ctx.program.symbols.getSerializer(
    ctx.program.symbols.idOf({
      moduleId: ctx.moduleId,
      symbol: typeExpr.symbol,
    }),
  );
};

const collectSerializersForType = ({
  typeId,
  ctx,
  serializers,
  seen,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  serializers: SerializerMetadata[];
  seen: Set<TypeId>;
}): void => {
  if (seen.has(typeId)) {
    return;
  }
  seen.add(typeId);

  collectLocalSerializersForType({ typeId, ctx, serializers });
  if (serializers.length > 0) {
    return;
  }

  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    collectSerializersForType({
      typeId: desc.body,
      ctx,
      serializers,
      seen,
    });
    return;
  }
  if (desc.kind === "intersection") {
    if (typeof desc.nominal === "number") {
      collectSerializersForType({
        typeId: desc.nominal,
        ctx,
        serializers,
        seen,
      });
    }
    if (typeof desc.structural === "number") {
      collectSerializersForType({
        typeId: desc.structural,
        ctx,
        serializers,
        seen,
      });
    }
  }
};

const collectLocalSerializersForType = ({
  typeId,
  ctx,
  serializers,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  serializers: SerializerMetadata[];
}): void => {
  const aliasSymbols = ctx.program.types.getAliasSymbols(typeId);
  aliasSymbols.forEach((symbol) => {
    const serializer = ctx.program.symbols.getSerializer(symbol);
    if (serializer) {
      serializers.push(serializer);
    }
  });

  const nominalOwner = ctx.program.types.getNominalOwner(typeId);
  if (nominalOwner) {
    const serializer = ctx.program.symbols.getSerializer(nominalOwner);
    if (serializer) {
      serializers.push(serializer);
    }
  }
};

export const resolveSerializerForTypes = (
  typeIds: readonly TypeId[],
  ctx: CodegenContext
): SerializerMetadata | undefined => {
  const serializers = typeIds
    .map((typeId) => findSerializerForType(typeId, ctx))
    .filter((serializer): serializer is SerializerMetadata => Boolean(serializer));
  if (serializers.length === 0) {
    return undefined;
  }
  const reference = serializers[0]!;
  const mismatch = serializers.find((serializer) => !sameSerializer(serializer, reference));
  if (mismatch) {
    throw new Error(`conflicting serializers for type list (format ${reference.formatId})`);
  }
  return reference;
};

export const serializerKeyFor = (
  serializer: SerializerMetadata
): string =>
  `serializer:${serializer.formatId}:${serializer.encode.moduleId}::${serializer.encode.symbol}:${serializer.decode.moduleId}::${serializer.decode.symbol}`;

const sameSerializer = (
  left: SerializerMetadata,
  right: SerializerMetadata
): boolean =>
  left.formatId === right.formatId &&
  left.encode.moduleId === right.encode.moduleId &&
  left.encode.symbol === right.encode.symbol &&
  left.decode.moduleId === right.decode.moduleId &&
  left.decode.symbol === right.decode.symbol;
