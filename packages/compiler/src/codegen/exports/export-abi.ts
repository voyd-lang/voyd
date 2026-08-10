import type binaryen from "binaryen";
import type { BoundarySchema } from "../boundary/schema.js";
import { SELECTED_HOST_TRANSPORT_IDENTITY } from "../host-transport/selected-provider.js";

export const EXPORT_ABI_SECTION = "voyd.export_abi";
export const HOST_ABI_VERSION = 2;
export const DTO_SCHEMA_ABI_VERSION = 1;

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

export const emitExportAbiSection = ({
  mod,
  entries,
}: {
  mod: binaryen.Module;
  entries: readonly ExportAbiEntry[];
}): void => {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const ids = new Set(sorted.map((entry) => entry.id));
  if (ids.size !== sorted.length) {
    throw new Error("host export identity collision");
  }
  const payload = JSON.stringify({
    version: 2,
    hostAbi: HOST_ABI_VERSION,
    dtoSchemaAbi: DTO_SCHEMA_ABI_VERSION,
    transport: SELECTED_HOST_TRANSPORT_IDENTITY,
    exports: sorted,
  });
  const bytes = new TextEncoder().encode(payload);
  mod.addCustomSection(EXPORT_ABI_SECTION, bytes);
};

export const hostExportId = (name: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 1;
};
