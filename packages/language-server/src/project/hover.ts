import type {
  Hover,
  MarkupContent,
  Position,
} from "vscode-languageserver/lib/node/main.js";
import { isInRange } from "./text.js";
import type { NavigationAnalysis, SymbolOccurrence } from "./types.js";

const findSymbolAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: NavigationAnalysis;
  uri: string;
  position: Position;
}): SymbolOccurrence | undefined => {
  const occurrences = analysis.occurrencesByUri.get(uri);
  if (!occurrences || occurrences.length === 0) {
    return undefined;
  }

  return occurrences.find((entry) => isInRange(position, entry.range));
};

export const hoverAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: NavigationAnalysis;
  uri: string;
  position: Position;
}): Hover | null => {
  const symbol = findSymbolAtPosition({ analysis, uri, position });
  if (!symbol) {
    return null;
  }

  const documentation = analysis.documentationByCanonicalKey.get(
    symbol.canonicalKey,
  );
  const typeInfo = analysis.typeInfoByCanonicalKey.get(symbol.canonicalKey);
  const typeExpandedInfo = analysis.typeExpandedInfoByCanonicalKey.get(
    symbol.canonicalKey,
  );
  if (documentation === undefined && typeInfo === undefined) {
    return null;
  }

  const blocks: string[] = [];
  if (typeInfo !== undefined) {
    blocks.push(`\`\`\`voyd\n${typeInfo}\n\`\`\``);
  }
  if (typeExpandedInfo !== undefined && typeExpandedInfo !== typeInfo) {
    blocks.push(
      `<details><summary>Expanded type</summary>\n\n\`\`\`voyd\n${typeExpandedInfo}\n\`\`\`\n</details>`,
    );
  }
  if (documentation !== undefined) {
    blocks.push(documentation);
  }

  const contents: MarkupContent = {
    kind: "markdown",
    value: blocks.join("\n\n"),
  };
  return { contents };
};
