import path from "node:path";
import type { SymbolId } from "@voyd-lang/compiler/semantics/ids.js";
import type { SemanticsPipelineResult } from "@voyd-lang/compiler/semantics/pipeline.js";
import type {
  CompletionExportEntry,
  CompletionIndex,
  CompletionScopedNodeSpan,
  CompletionSymbolLookup,
  ExportCandidate,
  SymbolOccurrence,
} from "./types.js";
import type { LineIndex } from "./text.js";
import { toFilePath } from "./files.js";

const PROJECT_ANALYSIS_CANCELLED_CODE = "VOYD_PROJECT_ANALYSIS_CANCELLED";

const throwIfCancelled = (isCancelled: (() => boolean) | undefined): void => {
  if (!isCancelled?.()) {
    return;
  }

  const error = new Error("project analysis cancelled") as Error & {
    code: string;
  };
  error.name = "ProjectAnalysisCancelledError";
  error.code = PROJECT_ANALYSIS_CANCELLED_CODE;
  throw error;
};

export const buildCompletionIndex = ({
  semantics,
  occurrencesByUri,
  lineIndexByFile,
  exportsByName,
  isCancelled,
}: {
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  occurrencesByUri: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  lineIndexByFile: ReadonlyMap<string, LineIndex>;
  exportsByName: ReadonlyMap<string, readonly ExportCandidate[]>;
  isCancelled?: () => boolean;
}): CompletionIndex => ({
  scopedNodesByModuleId: buildCompletionScopedNodesByModuleId({
    semantics,
    isCancelled,
  }),
  symbolLookupByUri: buildCompletionSymbolLookupByUri({
    occurrencesByUri,
    lineIndexByFile,
    isCancelled,
  }),
  exportEntriesByFirstCharacter: buildCompletionExportEntriesByFirstCharacter({
    exportsByName,
  }),
});

type SymbolLookupState = {
  declarationOffsetBySymbol: Map<SymbolId, number>;
  canonicalKeyBySymbol: Map<SymbolId, string>;
};

export const buildCompletionScopedNodesByModuleId = ({
  semantics,
  moduleIds,
  isCancelled,
}: {
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  moduleIds?: ReadonlySet<string>;
  isCancelled?: () => boolean;
}): Map<string, Map<string, CompletionScopedNodeSpan[]>> => {
  throwIfCancelled(isCancelled);

  const byModuleId = new Map<string, Map<string, CompletionScopedNodeSpan[]>>();

  semantics.forEach((moduleSemantics, moduleId) => {
    throwIfCancelled(isCancelled);

    if (moduleIds && !moduleIds.has(moduleId)) {
      return;
    }

    const byFile = new Map<string, CompletionScopedNodeSpan[]>();
    const nodes = [
      moduleSemantics.hir.module,
      ...moduleSemantics.hir.items.values(),
      ...moduleSemantics.hir.statements.values(),
      ...moduleSemantics.hir.expressions.values(),
    ];

    nodes.forEach((node) => {
      const scope = moduleSemantics.binding.scopeByNode.get(node.ast);
      if (scope === undefined) {
        return;
      }

      const filePath = path.resolve(node.span.file);
      const fileNodes = byFile.get(filePath) ?? [];
      fileNodes.push({
        start: node.span.start,
        end: node.span.end,
        scope,
        width: node.span.end - node.span.start,
      });
      byFile.set(filePath, fileNodes);
    });

    byFile.forEach((entries) => {
      entries.sort((left, right) => left.width - right.width);
    });
    byModuleId.set(moduleId, byFile);
  });

  return byModuleId;
};

export const buildCompletionSymbolLookupByUri = ({
  occurrencesByUri,
  lineIndexByFile,
  moduleIds,
  isCancelled,
}: {
  occurrencesByUri: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  lineIndexByFile: ReadonlyMap<string, LineIndex>;
  moduleIds?: ReadonlySet<string>;
  isCancelled?: () => boolean;
}): Map<string, Map<string, CompletionSymbolLookup>> => {
  throwIfCancelled(isCancelled);

  const symbolLookupByUri = new Map<string, Map<string, CompletionSymbolLookup>>();

  occurrencesByUri.forEach((occurrences, uri) => {
    throwIfCancelled(isCancelled);

    const filePath = path.resolve(toFilePath(uri));
    const lineIndex = lineIndexByFile.get(filePath);
    const byModuleId = new Map<string, SymbolLookupState>();

    occurrences.forEach((occurrence) => {
      if (moduleIds && !moduleIds.has(occurrence.moduleId)) {
        return;
      }

      const state = byModuleId.get(occurrence.moduleId) ?? {
        declarationOffsetBySymbol: new Map<SymbolId, number>(),
        canonicalKeyBySymbol: new Map<SymbolId, string>(),
      };
      byModuleId.set(occurrence.moduleId, state);

      if (!state.canonicalKeyBySymbol.has(occurrence.symbol)) {
        state.canonicalKeyBySymbol.set(occurrence.symbol, occurrence.canonicalKey);
      }

      if (occurrence.kind !== "declaration" || !lineIndex) {
        return;
      }

      const current = state.declarationOffsetBySymbol.get(occurrence.symbol);
      const next = lineIndex.offsetAt(occurrence.range.start);
      if (current === undefined || next < current) {
        state.declarationOffsetBySymbol.set(occurrence.symbol, next);
      }
    });

    if (byModuleId.size === 0) {
      return;
    }

    symbolLookupByUri.set(
      uri,
      new Map(
        Array.from(byModuleId.entries()).map(([moduleId, state]) => [
          moduleId,
          {
            declarationOffsetBySymbol: state.declarationOffsetBySymbol,
            canonicalKeyBySymbol: state.canonicalKeyBySymbol,
          },
        ]),
      ),
    );
  });

  return symbolLookupByUri;
};

export const buildCompletionExportEntriesByFirstCharacter = ({
  exportsByName,
}: {
  exportsByName: ReadonlyMap<string, readonly ExportCandidate[]>;
}): Map<string, CompletionExportEntry[]> => {
  const byFirstCharacter = new Map<string, CompletionExportEntry[]>();

  exportsByName.forEach((candidates, name) => {
    const firstCharacter = name.slice(0, 1).toLowerCase();
    const entries = byFirstCharacter.get(firstCharacter) ?? [];
    entries.push({
      name,
      candidates,
    });
    byFirstCharacter.set(firstCharacter, entries);
  });

  return byFirstCharacter;
};
