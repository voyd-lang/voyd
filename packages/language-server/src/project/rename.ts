import type {
  Location,
  Position,
  Range,
  TextEdit,
  WorkspaceEdit,
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

export const definitionsAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: NavigationAnalysis;
  uri: string;
  position: Position;
}): Location[] => {
  const symbol = findSymbolAtPosition({ analysis, uri, position });
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
  if (!symbol) {
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
  if (!symbol) {
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
