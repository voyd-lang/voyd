import type binaryen from "binaryen";
import type { BoundarySchema } from "../boundary/schema.js";

export const EXPORT_ABI_SECTION = "voyd.export_abi";
export const HOST_ABI_VERSION = 2;
export const DTO_SCHEMA_ABI_VERSION = 1;
export const DEFAULT_HOST_TRANSPORT = {
  id: "voyd.std.msgpack",
  version: 1,
} as const;

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
      wrapperName?: string;
      params?: readonly BoundarySchema[];
      result?: BoundarySchema;
    };

export const emitExportAbiSection = ({
  mod,
  entries,
}: {
  mod: binaryen.Module;
  entries: readonly ExportAbiEntry[];
}): void => {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const payload = JSON.stringify({
    version: 2,
    hostAbi: HOST_ABI_VERSION,
    dtoSchemaAbi: DTO_SCHEMA_ABI_VERSION,
    transport: DEFAULT_HOST_TRANSPORT,
    exports: sorted,
  });
  const bytes = new TextEncoder().encode(payload);
  mod.addCustomSection(EXPORT_ABI_SECTION, bytes);
};
