import type { CodegenContext, FunctionMetadata, TypeId } from "./context.js";
import {
  BoundarySchemaError,
  deriveBoundarySchema,
  type BoundarySchema,
} from "./boundary/schema.js";
import {
  boundaryMsgPackPayloadField,
  isBoundaryMsgPackValue,
} from "./boundary-metadata.js";
import { findSerializerForType } from "./serializer.js";
import type { SerializedExportTypeAdapter } from "./exports/serialized-abi.js";
import { getStructuralTypeInfo } from "./types.js";
import { loadStructuralField } from "./structural.js";

export type SerializedExportSpecialCase = {
  typeAdapter?: SerializedExportTypeAdapter;
  params?: readonly BoundarySchema[];
  result?: BoundarySchema;
};

export const createSerializedExportSpecialCaseResolver = <Entry>({
  ctx,
}: {
  entries: readonly Entry[];
  exportNameForEntry: (entry: Entry) => string;
  metaForEntry: (entry: Entry) => FunctionMetadata | undefined;
  ctx: CodegenContext;
}): ((params: {
  exportName: string;
  meta: FunctionMetadata;
}) => SerializedExportSpecialCase | undefined) => {
  return ({ exportName, meta }) => {
    if (!functionUsesBoundaryMsgPack(meta, ctx)) {
      return undefined;
    }
    return {
      typeAdapter: boundaryMsgPackTypeAdapter,
      ...boundaryMetadataFor({
        exportName,
        meta,
        ctx,
        typeAdapter: boundaryMsgPackTypeAdapter,
      }),
    };
  };
};

const functionUsesBoundaryMsgPack = (
  meta: FunctionMetadata,
  ctx: CodegenContext,
): boolean =>
  [...meta.paramTypeIds, meta.resultTypeId].some((typeId) =>
    boundaryMsgPackTypeAdapter.acceptsType?.({ typeId, ctx }) === true,
  );

const boundaryMsgPackTypeAdapter: SerializedExportTypeAdapter = {
  acceptsType: ({ typeId, ctx }) =>
    isBoundaryMsgPackValue(typeId, ctx) ||
    Boolean(boundaryMsgPackPayloadField(typeId, ctx)),
  packResultValue: ({ value, typeId, ctx }) => {
    if (isBoundaryMsgPackValue(typeId, ctx)) {
      return value;
    }
    const payloadField = boundaryMsgPackPayloadField(typeId, ctx);
    if (!payloadField) {
      return undefined;
    }
    const info = getStructuralTypeInfo(typeId, ctx);
    if (!info) {
      throw new Error(`boundary payload envelope ${typeId} is missing structural info`);
    }
    return loadStructuralField({
      structInfo: info,
      field: payloadField,
      pointer: () => value,
      ctx,
    });
  },
};

const boundaryMetadataFor = ({
  exportName,
  meta,
  ctx,
  typeAdapter,
}: {
  exportName: string;
  meta: FunctionMetadata;
  ctx: CodegenContext;
  typeAdapter?: SerializedExportTypeAdapter;
}): Pick<SerializedExportSpecialCase, "params" | "result"> => {
  const params = meta.paramTypeIds.map((typeId, index) =>
    schemaForSpecialSerializedType({
      typeId,
      ctx,
      typeAdapter,
      label: `${exportName} arg${index}`,
    }),
  );
  const result = schemaForSpecialSerializedType({
    typeId: meta.resultTypeId,
    ctx,
    typeAdapter,
    label: `${exportName} result`,
  });
  return {
    ...(params.every((schema): schema is BoundarySchema => schema !== undefined)
      ? { params }
      : {}),
    ...(result ? { result } : {}),
  };
};

const schemaForSpecialSerializedType = ({
  typeId,
  ctx,
  typeAdapter,
  label,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  typeAdapter?: SerializedExportTypeAdapter;
  label: string;
}): BoundarySchema | undefined => {
  if (findSerializerForType(typeId, ctx)) {
    return undefined;
  }
  if (typeAdapter?.acceptsType?.({ typeId, ctx }) === true) {
    return undefined;
  }
  try {
    return deriveBoundarySchema({
      typeId,
      ctx,
      label,
    });
  } catch (error) {
    if (error instanceof BoundarySchemaError) {
      return undefined;
    }
    throw error;
  }
};
