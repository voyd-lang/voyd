export type ScannedExportKind = "value" | "type" | "trait" | "effect";

export type ScannedExport = {
  name: string;
  kind: ScannedExportKind;
};

const exportRegexByKind: Record<ScannedExportKind, RegExp> = {
  value: /(?:^|\n)\s*pub\s+fn\s+([A-Za-z_][A-Za-z0-9_']*)/g,
  type: /(?:^|\n)\s*pub\s+(?:type|obj)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  trait: /(?:^|\n)\s*pub\s+trait\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  effect: /(?:^|\n)\s*pub\s+eff\s+([A-Za-z_][A-Za-z0-9_]*)/g,
};

export const scanExportsFromSource = (source: string): ScannedExport[] => {
  const exports: ScannedExport[] = [];

  (Object.entries(exportRegexByKind) as Array<[ScannedExportKind, RegExp]>).forEach(
    ([kind, regex]) => {
      regex.lastIndex = 0;
      let match = regex.exec(source);
      while (match) {
        const name = match[1];
        if (name) {
          exports.push({ name, kind });
        }
        match = regex.exec(source);
      }
    },
  );

  return exports;
};
