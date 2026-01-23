import type { CodegenContext } from "./context.js";
import type { SerializerMetadata } from "../semantics/symbol-index.js";
import type { TypeId } from "../semantics/ids.js";

export const findSerializerForType = (
  typeId: TypeId,
  ctx: CodegenContext
): SerializerMetadata | undefined => {
  const serializers: SerializerMetadata[] = [];

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
