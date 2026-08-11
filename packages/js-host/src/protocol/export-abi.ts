export type BoundaryPrimitiveSchema =
  | { kind: "bool"; typeId?: number }
  | { kind: "i32"; typeId?: number }
  | { kind: "i64"; typeId?: number }
  | { kind: "f32"; typeId?: number }
  | { kind: "f64"; typeId?: number }
  | { kind: "void"; typeId?: number }
  | { kind: "string"; typeId?: number }
  | { kind: "bytes"; typeId?: number };

export type BoundaryArraySchema = {
  kind: "array";
  typeId?: number;
  aliases?: readonly number[];
  elementTypeId?: number;
  element: BoundarySchema;
};

export type BoundaryFieldSchema = {
  name: string;
  typeId?: number;
  schema: BoundarySchema;
  optional?: boolean;
};

export type BoundaryRecordSchema = {
  kind: "record";
  typeId?: number;
  aliases?: readonly number[];
  name?: string;
  tag?: string;
  fields: readonly BoundaryFieldSchema[];
};

export type BoundaryVariantSchema = {
  name: string;
  typeId?: number;
  fields: readonly BoundaryFieldSchema[];
};

export type BoundaryUnionSchema = {
  kind: "union";
  typeId?: number;
  aliases?: readonly number[];
  name?: string;
  variants: readonly BoundaryVariantSchema[];
};

export type BoundaryRefSchema = {
  kind: "ref";
  typeId: number;
};

export type BoundaryCustomSchema = {
  kind: "custom";
  typeId: number;
  representationTypeId: number;
  representation: BoundarySchema;
};

export type BoundarySchema = (
  | BoundaryPrimitiveSchema
  | BoundaryArraySchema
  | BoundaryRecordSchema
  | BoundaryUnionSchema
  | BoundaryCustomSchema
  | BoundaryRefSchema
) & { fingerprint?: string };

export type ExportAbiEntry =
  | {
      id: number;
      name: string;
      abi: "direct";
      params?: readonly BoundarySchema[];
      result?: BoundarySchema;
    }
  | {
      id: number;
      name: string;
      abi: "serialized";
      wrapperName?: string;
      params?: readonly BoundarySchema[];
      result?: BoundarySchema;
    };

export type ParsedExportAbi = {
  version: number;
  host?: HostTransportMetadata;
  exports: ExportAbiEntry[];
  taskCompletions: Array<{ name: string; result: BoundarySchema }>;
  callbacks: Array<{
    name: string;
    params: readonly BoundarySchema[];
    result?: BoundarySchema;
  }>;
};

export const EXPORT_ABI_SECTION = "voyd.export_abi";

export const parseExportAbi = (
  module: WebAssembly.Module,
  sectionName = EXPORT_ABI_SECTION,
): ParsedExportAbi => {
  const sections = WebAssembly.Module.customSections(module, sectionName);
  if (sections.length === 0) {
    return { version: 0, exports: [], taskCompletions: [], callbacks: [] };
  }
  const payload = new Uint8Array(sections[0]!);
  const json = new TextDecoder().decode(payload);
  const parsed = JSON.parse(json) as {
    version?: number;
    hostAbi?: number;
    dtoSchemaAbi?: number;
    transport?: { id?: string; version?: number };
    exports?: ExportAbiEntry[];
    taskCompletions?: Array<{ name: string; result: BoundarySchema }>;
    callbacks?: Array<{
      name: string;
      params: readonly BoundarySchema[];
      result?: BoundarySchema;
    }>;
  };
  const host =
    typeof parsed.hostAbi === "number" &&
    typeof parsed.dtoSchemaAbi === "number" &&
    typeof parsed.transport?.id === "string" &&
    typeof parsed.transport.version === "number"
      ? {
          hostAbi: parsed.hostAbi,
          dtoSchemaAbi: parsed.dtoSchemaAbi,
          transport: {
            id: parsed.transport.id,
            version: parsed.transport.version,
          },
        }
      : undefined;
  return {
    version: typeof parsed.version === "number" ? parsed.version : 0,
    ...(host ? { host } : {}),
    exports: Array.isArray(parsed.exports) ? parsed.exports : [],
    taskCompletions: Array.isArray(parsed.taskCompletions)
      ? parsed.taskCompletions
      : [],
    callbacks: Array.isArray(parsed.callbacks) ? parsed.callbacks : [],
  };
};
import type { HostTransportMetadata } from "./host-transport.js";
