import path from "node:path";
import type { ScopeId } from "@voyd/compiler/semantics/ids.js";
import type {
  SymbolKind,
  SymbolRecord,
} from "@voyd/compiler/semantics/binder/types.js";
import {
  CompletionItemKind,
  type CompletionItem,
  type CompletionList,
  type MarkupContent,
  type Position,
} from "vscode-languageserver/lib/node/main.js";
import { toFilePath } from "./files.js";
import {
  insertImportEditFromContext,
  resolveImportInsertionContext,
} from "./auto-imports.js";
import type { CompletionAnalysis } from "./types.js";

const MAX_COMPLETION_ITEMS = 200;
const MAX_AUTO_IMPORT_ITEMS = 40;
const AUTO_IMPORT_MIN_PREFIX_LENGTH = 2;

const isIdentifierCharacter = (value: string | undefined): boolean =>
  Boolean(value && /[A-Za-z0-9_]/.test(value));

const offsetToReplace = ({
  source,
  cursorOffset,
}: {
  source: string;
  cursorOffset: number;
}): { start: number; end: number; prefix: string } => {
  let start = cursorOffset;
  while (start > 0 && isIdentifierCharacter(source[start - 1])) {
    start -= 1;
  }

  let end = cursorOffset;
  while (end < source.length && isIdentifierCharacter(source[end])) {
    end += 1;
  }

  return {
    start,
    end,
    prefix: source.slice(start, cursorOffset),
  };
};

const isVisibleSymbolKind = (kind: SymbolKind): boolean =>
  kind === "value" ||
  kind === "parameter" ||
  kind === "type" ||
  kind === "type-parameter" ||
  kind === "trait" ||
  kind === "effect" ||
  kind === "effect-op" ||
  kind === "module";

const padSortRank = (value: number): string => value.toString().padStart(3, "0");

const inScopeSymbolPriority = ({
  record,
  typeInfo,
}: {
  record: Readonly<SymbolRecord>;
  typeInfo: string | undefined;
}): number => {
  if (record.kind === "parameter") {
    return 0;
  }
  if (record.kind === "value") {
    return typeInfo?.startsWith("fn ") ? 1 : 0;
  }
  if (record.kind === "type" || record.kind === "type-parameter" || record.kind === "trait") {
    return 2;
  }
  if (record.kind === "effect-op") {
    return 3;
  }
  if (record.kind === "effect" || record.kind === "module") {
    return 4;
  }
  return 9;
};

const kindFromSymbolRecord = ({
  record,
  typeInfo,
}: {
  record: Readonly<SymbolRecord>;
  typeInfo: string | undefined;
}): CompletionItemKind => {
  if (record.kind === "value" || record.kind === "parameter") {
    return typeInfo?.startsWith("fn ")
      ? CompletionItemKind.Function
      : CompletionItemKind.Variable;
  }

  if (record.kind === "type") {
    return CompletionItemKind.Class;
  }
  if (record.kind === "trait") {
    return CompletionItemKind.Interface;
  }
  if (record.kind === "type-parameter") {
    return CompletionItemKind.TypeParameter;
  }
  if (record.kind === "effect-op") {
    return CompletionItemKind.Method;
  }
  if (record.kind === "module") {
    return CompletionItemKind.Module;
  }
  return CompletionItemKind.Class;
};

const kindFromExportKind = (kind: string): CompletionItemKind => {
  if (kind === "value") {
    return CompletionItemKind.Function;
  }
  if (kind === "type") {
    return CompletionItemKind.Class;
  }
  if (kind === "trait") {
    return CompletionItemKind.Interface;
  }
  if (kind === "module") {
    return CompletionItemKind.Module;
  }
  return CompletionItemKind.Text;
};

const autoImportPriorityFromKind = (kind: string): number => {
  if (kind === "value") {
    return 0;
  }
  if (kind === "type" || kind === "trait") {
    return 1;
  }
  if (kind === "module") {
    return 2;
  }
  return 9;
};

const symbolScopeChain = ({
  startScope,
  getParentScope,
}: {
  startScope: ScopeId;
  getParentScope: (scope: ScopeId) => ScopeId | null;
}): ScopeId[] => {
  const chain: ScopeId[] = [];
  let scope: ScopeId | null = startScope;

  while (scope !== null) {
    chain.push(scope);
    scope = getParentScope(scope);
  }

  return chain;
};

const findActiveScope = ({
  analysis,
  moduleId,
  filePath,
  cursorOffset,
}: {
  analysis: CompletionAnalysis;
  moduleId: string;
  filePath: string;
  cursorOffset: number;
}): ScopeId | undefined => {
  const semantics = analysis.semantics.get(moduleId);
  if (!semantics) {
    return undefined;
  }

  const nodes =
    analysis.completionIndex.scopedNodesByModuleId.get(moduleId)?.get(filePath) ?? [];
  for (const node of nodes) {
    if (cursorOffset >= node.start && cursorOffset <= node.end) {
      return node.scope;
    }
  }

  return semantics.binding.symbolTable.rootScope;
};

const startsWithPrefix = ({
  name,
  prefix,
}: {
  name: string;
  prefix: string;
}): boolean => {
  if (prefix.length === 0) {
    return true;
  }
  return name.startsWith(prefix);
};

const isImportedSymbol = (record: Readonly<SymbolRecord>): boolean => {
  const metadata = record.metadata as { import?: unknown } | undefined;
  return metadata?.import !== undefined;
};

const completionsForInScopeSymbols = ({
  analysis,
  moduleId,
  uri,
  prefix,
  replacementStartOffset,
  replacementEndOffset,
  cursorOffset,
  activeScope,
}: {
  analysis: CompletionAnalysis;
  moduleId: string;
  uri: string;
  prefix: string;
  replacementStartOffset: number;
  replacementEndOffset: number;
  cursorOffset: number;
  activeScope: ScopeId;
}): { items: CompletionItem[]; visibleNames: Set<string> } => {
  const semantics = analysis.semantics.get(moduleId);
  const lineIndex = analysis.lineIndexByFile.get(path.resolve(toFilePath(uri)));
  if (!semantics || !lineIndex) {
    return { items: [], visibleNames: new Set<string>() };
  }

  const symbolLookup = analysis.completionIndex.symbolLookupByUri.get(uri)?.get(moduleId);
  const declarationOffsetBySymbol = symbolLookup?.declarationOffsetBySymbol;
  const canonicalKeyBySymbol = symbolLookup?.canonicalKeyBySymbol;

  const replacementRange = {
    start: lineIndex.positionAt(replacementStartOffset),
    end: lineIndex.positionAt(replacementEndOffset),
  };

  const visibleNames = new Set<string>();
  const items: CompletionItem[] = [];
  const scopeChain = symbolScopeChain({
    startScope: activeScope,
    getParentScope: (scope) => semantics.binding.symbolTable.getScope(scope).parent,
  });

  for (let scopeDepth = 0; scopeDepth < scopeChain.length; scopeDepth += 1) {
    const scope = scopeChain[scopeDepth]!;
    const scopeSymbols = Array.from(semantics.binding.symbolTable.symbolsInScope(scope));
    for (let index = scopeSymbols.length - 1; index >= 0; index -= 1) {
      const symbol = scopeSymbols[index]!;
      const record = semantics.binding.symbolTable.getSymbol(symbol);
      if (!isVisibleSymbolKind(record.kind)) {
        continue;
      }
      if (visibleNames.has(record.name)) {
        continue;
      }
      if (!startsWithPrefix({ name: record.name, prefix })) {
        continue;
      }

      const declarationOffset = declarationOffsetBySymbol?.get(symbol);
      const scopeKind = semantics.binding.symbolTable.getScope(record.scope).kind;
      const isModuleScoped =
        scopeKind === "module" || scopeKind === "macro";

      if (
        !isModuleScoped &&
        declarationOffset !== undefined &&
        declarationOffset > cursorOffset
      ) {
        continue;
      }

      visibleNames.add(record.name);

      const canonicalKey = canonicalKeyBySymbol?.get(symbol);
      const typeInfo = canonicalKey
        ? analysis.typeInfoByCanonicalKey.get(canonicalKey)
        : undefined;
      const documentation = canonicalKey
        ? analysis.documentationByCanonicalKey.get(canonicalKey)
        : undefined;
      const markdownDocumentation: MarkupContent | undefined = documentation
        ? { kind: "markdown", value: documentation }
        : undefined;
      const item: CompletionItem = {
        label: record.name,
        kind: kindFromSymbolRecord({ record, typeInfo }),
        sortText: [
          "0",
          padSortRank(scopeDepth),
          padSortRank(inScopeSymbolPriority({ record, typeInfo })),
          record.name,
        ].join(":"),
        detail: typeInfo,
        documentation: markdownDocumentation,
        textEdit: {
          range: replacementRange,
          newText: record.name,
        },
      };

      if (isImportedSymbol(record)) {
        item.detail = item.detail ?? "(imported symbol)";
      }

      items.push(item);
      if (items.length >= MAX_COMPLETION_ITEMS) {
        return { items, visibleNames };
      }
    }
  }

  return { items, visibleNames };
};

const completionsForAutoImports = ({
  analysis,
  moduleId,
  uri,
  source,
  prefix,
  replacementStartOffset,
  replacementEndOffset,
  visibleNames,
  maxItems,
}: {
  analysis: CompletionAnalysis;
  moduleId: string;
  uri: string;
  source: string;
  prefix: string;
  replacementStartOffset: number;
  replacementEndOffset: number;
  visibleNames: ReadonlySet<string>;
  maxItems: number;
}): { items: CompletionItem[]; isIncomplete: boolean } => {
  if (prefix.length < AUTO_IMPORT_MIN_PREFIX_LENGTH || maxItems <= 0) {
    return { items: [], isIncomplete: false };
  }

  const lineIndex = analysis.lineIndexByFile.get(path.resolve(toFilePath(uri)));
  if (!lineIndex) {
    return { items: [], isIncomplete: false };
  }

  const replacementRange = {
    start: lineIndex.positionAt(replacementStartOffset),
    end: lineIndex.positionAt(replacementEndOffset),
  };
  const importInsertionContext = resolveImportInsertionContext({
    analysis,
    documentUri: uri,
  });
  if (!importInsertionContext) {
    return { items: [], isIncomplete: false };
  }
  const existingImportLines = new Set(source.split("\n").map((line) => line.trim()));
  const seenSuggestions = new Set<string>();
  const suggestions: CompletionItem[] = [];
  const firstCharacter = prefix.slice(0, 1).toLowerCase();
  const matchingEntries =
    analysis.completionIndex.exportEntriesByFirstCharacter.get(firstCharacter) ?? [];

  for (const { name: exportedName, candidates } of matchingEntries) {
    if (!startsWithPrefix({ name: exportedName, prefix })) {
      continue;
    }
    if (visibleNames.has(exportedName)) {
      continue;
    }

    for (const candidate of candidates) {
      if (candidate.moduleId === moduleId) {
        continue;
      }
      const suggestionKey = `${candidate.name}:${candidate.moduleId}`;
      if (seenSuggestions.has(suggestionKey)) {
        continue;
      }
      seenSuggestions.add(suggestionKey);

      const importLine = `use ${candidate.moduleId}::${candidate.name}`;
      if (existingImportLines.has(importLine)) {
        continue;
      }

      const additionalEdit = insertImportEditFromContext({
        context: importInsertionContext,
        importLine,
      });

      suggestions.push({
        label: candidate.name,
        kind: kindFromExportKind(candidate.kind),
        detail: `${candidate.kind} from ${candidate.moduleId}`,
        sortText: [
          "9",
          padSortRank(autoImportPriorityFromKind(candidate.kind)),
          candidate.name,
          candidate.moduleId,
        ].join(":"),
        textEdit: {
          range: replacementRange,
          newText: candidate.name,
        },
        additionalTextEdits: [additionalEdit],
      });

      if (suggestions.length >= maxItems) {
        return { items: suggestions, isIncomplete: true };
      }
    }
  }

  return { items: suggestions, isIncomplete: false };
};

export const completionsAtPosition = ({
  analysis,
  uri,
  position,
}: {
  analysis: CompletionAnalysis;
  uri: string;
  position: Position;
}): CompletionList => {
  const filePath = path.resolve(toFilePath(uri));
  const moduleId = analysis.moduleIdByFilePath.get(filePath);
  const lineIndex = analysis.lineIndexByFile.get(filePath);
  const source = analysis.sourceByFile.get(filePath);

  if (!moduleId || !lineIndex || source === undefined) {
    return { isIncomplete: false, items: [] };
  }

  const cursorOffset = lineIndex.offsetAt(position);
  const replacement = offsetToReplace({
    source,
    cursorOffset,
  });
  const activeScope = findActiveScope({
    analysis,
    moduleId,
    filePath,
    cursorOffset,
  });
  if (activeScope === undefined) {
    return { isIncomplete: false, items: [] };
  }

  const inScope = completionsForInScopeSymbols({
    analysis,
    moduleId,
    uri,
    prefix: replacement.prefix,
    replacementStartOffset: replacement.start,
    replacementEndOffset: replacement.end,
    cursorOffset,
    activeScope,
  });
  if (inScope.items.length >= MAX_COMPLETION_ITEMS) {
    return {
      isIncomplete: true,
      items: inScope.items,
    };
  }

  const autoImportLimit = Math.max(
    0,
    Math.min(MAX_AUTO_IMPORT_ITEMS, MAX_COMPLETION_ITEMS - inScope.items.length),
  );
  const autoImports = completionsForAutoImports({
    analysis,
    moduleId,
    uri,
    source,
    prefix: replacement.prefix,
    replacementStartOffset: replacement.start,
    replacementEndOffset: replacement.end,
    visibleNames: inScope.visibleNames,
    maxItems: autoImportLimit,
  });

  const items = [...inScope.items, ...autoImports.items].slice(0, MAX_COMPLETION_ITEMS);
  return {
    isIncomplete: autoImports.isIncomplete || items.length >= MAX_COMPLETION_ITEMS,
    items,
  };
};
