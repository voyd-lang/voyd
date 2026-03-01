import type {
  Location,
  Position,
  Range,
  TextEdit,
  WorkspaceEdit,
} from "vscode-languageserver/lib/node/main.js";
import { isInRange } from "./text.js";
import type { NavigationAnalysis, SymbolOccurrence } from "./types.js";

const symbolsAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: NavigationAnalysis;
  uri: string;
  position: Position;
}): SymbolOccurrence[] => {
  const occurrences = analysis.occurrencesByUri.get(uri);
  if (!occurrences || occurrences.length === 0) {
    return [];
  }

  return occurrences.filter((entry) => isInRange(position, entry.range));
};

const findSymbolAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: NavigationAnalysis;
  uri: string;
  position: Position;
}): SymbolOccurrence | undefined => {
  return symbolsAtPosition({ analysis, uri, position })[0];
};

const findSymbolWithDeclarationAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: NavigationAnalysis;
  uri: string;
  position: Position;
}): SymbolOccurrence | undefined => {
  const matches = symbolsAtPosition({ analysis, uri, position });
  if (matches.length === 0) {
    return undefined;
  }

  return (
    matches.find(
      (entry) => (analysis.declarationsByKey.get(entry.canonicalKey)?.length ?? 0) > 0,
    ) ?? matches[0]
  );
};

export const definitionsAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: NavigationAnalysis;
  uri: string;
  position: Position;
}): Location[] => {
  const symbol = findSymbolWithDeclarationAtPosition({ analysis, uri, position });
  if (!symbol) {
    return [];
  }

  const declarations = analysis.declarationsByKey.get(symbol.canonicalKey) ?? [];
  return declarations.map((entry) => ({
    uri: entry.uri,
    range: entry.range,
  }));
};

export const prepareRenameAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: NavigationAnalysis;
  uri: string;
  position: Position;
}): { range: Range; placeholder: string } | null => {
  const symbol = findSymbolAtPosition({ analysis, uri, position });
  if (!symbol || symbol.symbol < 0) {
    return null;
  }

  return { range: symbol.range, placeholder: symbol.name };
};

export const renameAtPosition = ({
  analysis,
  uri,
  position,
  newName,
}: {
  analysis: NavigationAnalysis;
  uri: string;
  position: Position;
  newName: string;
}): WorkspaceEdit | null => {
  const symbol = findSymbolAtPosition({ analysis, uri, position });
  if (!symbol || symbol.symbol < 0) {
    return null;
  }

  const editsByUri = new Map<string, TextEdit[]>();
  const allOccurrences =
    analysis.occurrencesByUri
      .get(uri)
      ?.filter((entry) => entry.canonicalKey === symbol.canonicalKey) ?? [];

  Array.from(analysis.occurrencesByUri.values())
    .flat()
    .filter((entry) => entry.canonicalKey === symbol.canonicalKey)
    .forEach((entry) => {
      const edits = editsByUri.get(entry.uri) ?? [];
      edits.push({ range: entry.range, newText: newName });
      editsByUri.set(entry.uri, edits);
    });

  if (allOccurrences.length === 0 && editsByUri.size === 0) {
    return null;
  }

  return {
    changes: Object.fromEntries(editsByUri.entries()),
  };
};
