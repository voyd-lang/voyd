export type ExportAbiEntry = {
  name: string;
  abi: "direct" | "serialized";
  formatId?: string;
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
