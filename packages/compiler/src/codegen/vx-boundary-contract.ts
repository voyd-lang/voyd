import type {
  CodegenContext,
  FunctionMetadata,
  StructuralFieldInfo,
  TypeId,
} from "./context.js";
import type { ProgramSymbolId } from "../semantics/ids.js";
import { loadStructuralField } from "./structural.js";
import { getStructuralTypeInfo } from "./types.js";
import { findSerializerForType } from "./serializer.js";
import type { SerializedExportTypeAdapter } from "./exports/serialized-abi.js";

const VX_BOUNDARY_EXPORT_NAMES = new Set([
  "init",
  "update",
  "view",
  "subscriptions",
]);
const VX_SERIALIZED_ALIAS_NAMES = new Set(["Html", "Attr", "Program"]);
const VX_LIFECYCLE_ALIAS_NAMES = new Set(["Html", "Program"]);
const VX_SERIALIZED_PAYLOAD_ENVELOPE_NAMES = new Set(["Cmd", "Sub"]);
const VX_LIFECYCLE_PAYLOAD_ENVELOPE_NAMES = new Set(["Sub"]);
const VX_STD_MODULE_ID = "std::vx";

export const createVxLifecycleSerializedExportPredicate = <Entry>({
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
}) => boolean) => {
  const moduleHasVxAppShape = entries.some((entry) => {
    const exportName = exportNameForEntry(entry);
    const meta = metaForEntry(entry);
    if (!meta) return false;
    return isVxAppShapeExport({ exportName, meta, ctx });
  });
  return ({ exportName, meta }) =>
    shouldEmitVxLifecycleSerializedWrapper({
      exportName,
      meta,
      moduleHasVxAppShape,
      ctx,
    });
};

const shouldEmitVxLifecycleSerializedWrapper = ({
  exportName,
  meta,
  moduleHasVxAppShape,
  ctx,
}: {
  exportName: string;
  meta: FunctionMetadata;
  moduleHasVxAppShape: boolean;
  ctx: CodegenContext;
}): boolean => {
  if (!VX_BOUNDARY_EXPORT_NAMES.has(exportName)) return false;
  if (exportName === "view") return isVxViewLifecycleMeta(meta, ctx);
  if (exportName === "subscriptions") {
    return isVxSubscriptionsLifecycleMeta(meta, ctx);
  }
  if (exportName === "init") return moduleHasVxAppShape && meta.paramTypeIds.length === 0;
  if (exportName === "update") return moduleHasVxAppShape && meta.paramTypeIds.length === 2;
  return false;
};

const isVxAppShapeExport = ({
  exportName,
  meta,
  ctx,
}: {
  exportName: string;
  meta: FunctionMetadata;
  ctx: CodegenContext;
}): boolean =>
  (exportName === "view" && isVxViewLifecycleMeta(meta, ctx)) ||
  (exportName === "subscriptions" && isVxSubscriptionsLifecycleMeta(meta, ctx));

const isVxViewLifecycleMeta = (
  meta: FunctionMetadata,
  ctx: CodegenContext,
): boolean =>
  meta.paramTypeIds.length === 1 &&
  hasTypeAliasNamed(meta.resultTypeId, VX_LIFECYCLE_ALIAS_NAMES, ctx);

const isVxSubscriptionsLifecycleMeta = (
  meta: FunctionMetadata,
  ctx: CodegenContext,
): boolean =>
  meta.paramTypeIds.length === 1 &&
  isVxPayloadEnvelopeNamed(meta.resultTypeId, VX_LIFECYCLE_PAYLOAD_ENVELOPE_NAMES, ctx);

export const vxSerializedExportTypeAdapter: SerializedExportTypeAdapter = {
  acceptsType: ({ typeId, ctx }) =>
    isVxSerializedAlias(typeId, ctx) || vxSerializedPayloadField(typeId, ctx) !== undefined,
  packResultValue: ({ value, typeId, ctx }) => {
    if (isVxSerializedAlias(typeId, ctx)) {
      return value;
    }
    const payloadField = vxSerializedPayloadField(typeId, ctx);
    if (!payloadField) {
      return undefined;
    }
    const info = getStructuralTypeInfo(typeId, ctx);
    if (!info) {
      throw new Error(`VX payload envelope ${typeId} is missing structural info`);
    }
    return loadStructuralField({
      structInfo: info,
      field: payloadField,
      pointer: () => value,
      ctx,
    });
  },
};

const hasTypeAliasNamed = (
  typeId: TypeId,
  names: ReadonlySet<string>,
  ctx: CodegenContext,
): boolean =>
  ctx.program.types
    .getAliasSymbols(typeId)
    .some((symbol) => isStdVxSymbolNamed(symbol, names, ctx));

const isVxSerializedAlias = (typeId: TypeId, ctx: CodegenContext): boolean =>
  hasTypeAliasNamed(typeId, VX_SERIALIZED_ALIAS_NAMES, ctx);

const isVxPayloadEnvelopeNamed = (
  typeId: TypeId,
  names: ReadonlySet<string>,
  ctx: CodegenContext,
): boolean => nominalTypeSymbolIsStdVxNamed(typeId, names, ctx);

const vxSerializedPayloadField = (
  typeId: TypeId,
  ctx: CodegenContext,
): StructuralFieldInfo | undefined => {
  if (!isVxPayloadEnvelopeNamed(typeId, VX_SERIALIZED_PAYLOAD_ENVELOPE_NAMES, ctx)) {
    return undefined;
  }
  const info = getStructuralTypeInfo(typeId, ctx);
  const payload = info?.fieldMap.get("payload");
  if (!payload) {
    return undefined;
  }
  const serializer = findSerializerForType(payload.typeId, ctx);
  return serializer?.formatId === "msgpack" ? payload : undefined;
};

const isStdVxSymbolNamed = (
  symbol: ProgramSymbolId,
  names: ReadonlySet<string>,
  ctx: CodegenContext,
): boolean =>
  ctx.program.symbols.refOf(symbol).moduleId === VX_STD_MODULE_ID &&
  names.has(ctx.program.symbols.getName(symbol) ?? "");

const nominalTypeSymbolIsStdVxNamed = (
  typeId: TypeId,
  names: ReadonlySet<string>,
  ctx: CodegenContext,
): boolean => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  const nominal =
    desc.kind === "intersection" && typeof desc.nominal === "number"
      ? ctx.program.types.getTypeDesc(desc.nominal)
      : desc;
  if (nominal.kind !== "nominal-object" && nominal.kind !== "value-object") {
    return false;
  }
  return isStdVxSymbolNamed(nominal.owner, names, ctx);
};
