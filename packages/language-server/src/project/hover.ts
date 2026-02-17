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
  if (documentation === undefined) {
    return null;
  }

  const contents: MarkupContent = {
    kind: "markdown",
    value: documentation,
  };
  return { contents };
};
