import type { CodegenContext, FunctionMetadata, TypeId } from "./context.js";
import {
  BoundarySchemaError,
  deriveBoundarySchema,
  type BoundarySchema,
} from "./boundary/schema.js";
import {
  createVxLifecycleSerializedExportPredicate,
  vxSerializedExportTypeAdapter,
} from "./vx-boundary-contract.js";
import { findSerializerForType } from "./serializer.js";
import type { SerializedExportTypeAdapter } from "./exports/serialized-abi.js";

export type SerializedExportSpecialCase = {
  typeAdapter?: SerializedExportTypeAdapter;
  params?: readonly BoundarySchema[];
  result?: BoundarySchema;
};

export const createSerializedExportSpecialCaseResolver = <Entry>({
  entries,
  exportNameForEntry,
  metaForEntry,
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
  const isVxLifecycleExport = createVxLifecycleSerializedExportPredicate({
    entries,
    exportNameForEntry,
    metaForEntry,
    ctx,
  });
  return ({ exportName, meta }) => {
    if (!isVxLifecycleExport({ exportName, meta })) {
      return undefined;
    }
    return {
      typeAdapter: vxSerializedExportTypeAdapter,
      ...boundaryMetadataFor({
        exportName,
        meta,
        ctx,
        typeAdapter: vxSerializedExportTypeAdapter,
      }),
    };
  };
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
