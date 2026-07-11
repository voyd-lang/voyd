export type BoundaryPrimitiveSchema =
  | { kind: "bool"; typeId?: number }
  | { kind: "i32"; typeId?: number }
  | { kind: "i64"; typeId?: number }
  | { kind: "f32"; typeId?: number }
  | { kind: "f64"; typeId?: number }
  | { kind: "void"; typeId?: number }
  | { kind: "string"; typeId?: number };

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

export type BoundarySchema =
  | BoundaryPrimitiveSchema
  | BoundaryArraySchema
  | BoundaryRecordSchema
  | BoundaryUnionSchema
  | BoundaryRefSchema;

export type ExportAbiEntry =
  | {
      name: string;
      abi: "direct";
      params?: readonly BoundarySchema[];
      result?: BoundarySchema;
    }
  | {
      name: string;
      abi: "serialized";
      formatId?: string;
      wrapperName?: string;
      params?: readonly BoundarySchema[];
      result?: BoundarySchema;
    };

export type ParsedExportAbi = {
  version: number;
  exports: ExportAbiEntry[];
};

export const EXPORT_ABI_SECTION = "voyd.export_abi";

export const parseExportAbi = (
  module: WebAssembly.Module,
  sectionName = EXPORT_ABI_SECTION
): ParsedExportAbi => {
  const sections = WebAssembly.Module.customSections(module, sectionName);
  if (sections.length === 0) {
    return { version: 0, exports: [] };
  }
  const payload = new Uint8Array(sections[0]!);
  const json = new TextDecoder().decode(payload);
  const parsed = JSON.parse(json) as { version?: number; exports?: ExportAbiEntry[] };
  return {
    version: typeof parsed.version === "number" ? parsed.version : 0,
    exports: Array.isArray(parsed.exports) ? parsed.exports : [],
  };
};
