import path from "node:path";
import type { ScopeId, SourceSpan, SymbolId } from "@voyd/compiler/semantics/ids.js";
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

const spanContainsOffset = ({
  span,
  filePath,
  offset,
}: {
  span: SourceSpan;
  filePath: string;
  offset: number;
}): boolean => {
  if (path.resolve(span.file) !== filePath) {
    return false;
  }
  return offset >= span.start && offset <= span.end;
};

const spanWidth = (span: SourceSpan): number => span.end - span.start;

const isVisibleSymbolKind = (kind: SymbolKind): boolean =>
  kind === "value" ||
  kind === "parameter" ||
  kind === "type" ||
  kind === "type-parameter" ||
  kind === "trait" ||
  kind === "effect" ||
  kind === "effect-op" ||
  kind === "module";

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

const declarationStartOffsetsByAstNode = ({
  moduleId,
  analysis,
}: {
  moduleId: string;
  analysis: CompletionAnalysis;
}): Map<number, number> => {
  const semantics = analysis.semantics.get(moduleId);
  if (!semantics) {
    return new Map<number, number>();
  }

  const byAstNode = new Map<number, number>();
  const nodes = [
    semantics.hir.module,
    ...semantics.hir.items.values(),
    ...semantics.hir.statements.values(),
    ...semantics.hir.expressions.values(),
  ];

  nodes.forEach((node) => {
    const current = byAstNode.get(node.ast);
    if (current === undefined || node.span.start < current) {
      byAstNode.set(node.ast, node.span.start);
    }
  });

  return byAstNode;
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

  const nodes = [
    semantics.hir.module,
    ...semantics.hir.items.values(),
    ...semantics.hir.statements.values(),
    ...semantics.hir.expressions.values(),
  ];

  const containing = nodes
    .filter((node) =>
      spanContainsOffset({
        span: node.span,
        filePath,
        offset: cursorOffset,
      }),
    )
    .sort((left, right) => spanWidth(left.span) - spanWidth(right.span));

  const targetNode = containing.find((node) =>
    semantics.binding.scopeByNode.has(node.ast),
  );
  if (targetNode) {
    return semantics.binding.scopeByNode.get(targetNode.ast);
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

  const declarationOffsetBySymbol = new Map<SymbolId, number>();
  (analysis.occurrencesByUri.get(uri) ?? [])
    .filter((entry) => entry.moduleId === moduleId && entry.kind === "declaration")
    .forEach((entry) => {
      const current = declarationOffsetBySymbol.get(entry.symbol);
      const next = lineIndex.offsetAt(entry.range.start);
      if (current === undefined || next < current) {
        declarationOffsetBySymbol.set(entry.symbol, next);
      }
    });
  const declarationOffsetByAstNode = declarationStartOffsetsByAstNode({
    moduleId,
    analysis,
  });

  const canonicalKeyBySymbol = new Map<SymbolId, string>();
  analysis.declarationsByKey.forEach((entries, canonicalKey) => {
    entries.forEach((entry) => {
      if (entry.moduleId !== moduleId || canonicalKeyBySymbol.has(entry.symbol)) {
        return;
      }
      canonicalKeyBySymbol.set(entry.symbol, canonicalKey);
    });
  });
  (analysis.occurrencesByUri.get(uri) ?? []).forEach((entry) => {
    if (entry.moduleId !== moduleId || canonicalKeyBySymbol.has(entry.symbol)) {
      return;
    }
    canonicalKeyBySymbol.set(entry.symbol, entry.canonicalKey);
  });

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

  for (const scope of scopeChain) {
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

      const declarationOffset = declarationOffsetBySymbol.get(symbol);
      const declarationOffsetFromAst = declarationOffsetByAstNode.get(
        record.declaredAt,
      );
      const effectiveDeclarationOffset =
        declarationOffset ?? declarationOffsetFromAst;
      const scopeKind = semantics.binding.symbolTable.getScope(record.scope).kind;
      const isModuleScoped =
        scopeKind === "module" || scopeKind === "macro";

      if (
        !isModuleScoped &&
        effectiveDeclarationOffset !== undefined &&
        effectiveDeclarationOffset > cursorOffset
      ) {
        continue;
      }

      visibleNames.add(record.name);

      const canonicalKey = canonicalKeyBySymbol.get(symbol);
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
        sortText: `1:${record.name}`,
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
}: {
  analysis: CompletionAnalysis;
  moduleId: string;
  uri: string;
  source: string;
  prefix: string;
  replacementStartOffset: number;
  replacementEndOffset: number;
  visibleNames: ReadonlySet<string>;
}): CompletionItem[] => {
  if (prefix.length === 0) {
    return [];
  }

  const lineIndex = analysis.lineIndexByFile.get(path.resolve(toFilePath(uri)));
  if (!lineIndex) {
    return [];
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
    return [];
  }
  const existingImportLines = new Set(source.split("\n").map((line) => line.trim()));
  const seenSuggestions = new Set<string>();
  const suggestions: CompletionItem[] = [];

  analysis.exportsByName.forEach((candidates, exportedName) => {
    if (!startsWithPrefix({ name: exportedName, prefix })) {
      return;
    }
    if (visibleNames.has(exportedName)) {
      return;
    }

    candidates.forEach((candidate) => {
      if (candidate.moduleId === moduleId) {
        return;
      }
      const suggestionKey = `${candidate.name}:${candidate.moduleId}`;
      if (seenSuggestions.has(suggestionKey)) {
        return;
      }
      seenSuggestions.add(suggestionKey);

      const importLine = `use ${candidate.moduleId}::${candidate.name}`;
      if (existingImportLines.has(importLine)) {
        return;
      }

      const additionalEdit = insertImportEditFromContext({
        context: importInsertionContext,
        importLine,
      });

      suggestions.push({
        label: candidate.name,
        kind: kindFromExportKind(candidate.kind),
        detail: `${candidate.kind} from ${candidate.moduleId}`,
        sortText: `2:${candidate.name}:${candidate.moduleId}`,
        textEdit: {
          range: replacementRange,
          newText: candidate.name,
        },
        additionalTextEdits: [additionalEdit],
      });
    });
  });

  return suggestions;
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

  const autoImports = completionsForAutoImports({
    analysis,
    moduleId,
    uri,
    source,
    prefix: replacement.prefix,
    replacementStartOffset: replacement.start,
    replacementEndOffset: replacement.end,
    visibleNames: inScope.visibleNames,
  });

  const items = [...inScope.items, ...autoImports].slice(0, MAX_COMPLETION_ITEMS);
  return {
    isIncomplete: items.length >= MAX_COMPLETION_ITEMS,
    items,
  };
};
