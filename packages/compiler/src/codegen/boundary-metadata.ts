import type {
  CodegenContext,
  StructuralFieldInfo,
  TypeId,
} from "./context.js";
import { findSerializerForType } from "./serializer.js";
import { getStructuralTypeInfo } from "./types.js";

export const isBoundaryMsgPackValue = (
  typeId: TypeId,
  ctx: CodegenContext,
): boolean =>
  ctx.program.types
    .getAliasSymbols(typeId)
    .some(
      (symbol) => ctx.program.symbols.getBoundary(symbol)?.type === "value",
    );

export const isBoundaryMsgPackPayload = (
  typeId: TypeId,
  ctx: CodegenContext,
): boolean => Boolean(boundaryMsgPackPayloadField(typeId, ctx));

export const boundaryMsgPackPayloadField = (
  typeId: TypeId,
  ctx: CodegenContext,
): StructuralFieldInfo | undefined => {
  const metadata = boundaryMetadataForNominalType(typeId, ctx);
  if (metadata?.type !== "payload" || !metadata.field) {
    return undefined;
  }
  const info = getStructuralTypeInfo(typeId, ctx);
  const payload = info?.fieldMap.get(metadata.field);
  if (!payload) {
    return undefined;
  }
  const serializer = findSerializerForType(payload.typeId, ctx);
  return serializer?.formatId === "msgpack" ? payload : undefined;
};

const boundaryMetadataForNominalType = (
  typeId: TypeId,
  ctx: CodegenContext,
) => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  const nominal =
    desc.kind === "intersection" && typeof desc.nominal === "number"
      ? ctx.program.types.getTypeDesc(desc.nominal)
      : desc;
  if (nominal.kind !== "nominal-object" && nominal.kind !== "value-object") {
    return undefined;
  }
  return ctx.program.symbols.getBoundary(nominal.owner);
};
