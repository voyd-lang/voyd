import type binaryen from "binaryen";

export const EXPORT_ABI_SECTION = "voyd.export_abi";

export type ExportAbiEntry = {
  name: string;
  abi: "direct" | "serialized";
  formatId?: string;
};

export const emitExportAbiSection = ({
  mod,
  entries,
}: {
  mod: binaryen.Module;
  entries: readonly ExportAbiEntry[];
}): void => {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const payload = JSON.stringify({ version: 1, exports: sorted });
  const bytes = new TextEncoder().encode(payload);
  mod.addCustomSection(EXPORT_ABI_SECTION, bytes);
};
