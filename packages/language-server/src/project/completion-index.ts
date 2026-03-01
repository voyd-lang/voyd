import path from "node:path";
import type { SymbolId } from "@voyd/compiler/semantics/ids.js";
import type { SemanticsPipelineResult } from "@voyd/compiler/semantics/pipeline.js";
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

export const buildCompletionIndex = ({
  semantics,
  occurrencesByUri,
  lineIndexByFile,
  exportsByName,
}: {
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
  occurrencesByUri: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  lineIndexByFile: ReadonlyMap<string, LineIndex>;
  exportsByName: ReadonlyMap<string, readonly ExportCandidate[]>;
}): CompletionIndex => ({
  scopedNodesByModuleId: buildScopedNodesByModuleId({ semantics }),
  symbolLookupByUri: buildSymbolLookupByUri({
    occurrencesByUri,
    lineIndexByFile,
  }),
  exportEntriesByFirstCharacter: buildExportEntriesByFirstCharacter({
    exportsByName,
  }),
});

type SymbolLookupState = {
  declarationOffsetBySymbol: Map<SymbolId, number>;
  canonicalKeyBySymbol: Map<SymbolId, string>;
};

const buildScopedNodesByModuleId = ({
  semantics,
}: {
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
}): Map<string, Map<string, CompletionScopedNodeSpan[]>> => {
  const byModuleId = new Map<string, Map<string, CompletionScopedNodeSpan[]>>();

  semantics.forEach((moduleSemantics, moduleId) => {
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

const buildSymbolLookupByUri = ({
  occurrencesByUri,
  lineIndexByFile,
}: {
  occurrencesByUri: ReadonlyMap<string, readonly SymbolOccurrence[]>;
  lineIndexByFile: ReadonlyMap<string, LineIndex>;
}): Map<string, Map<string, CompletionSymbolLookup>> => {
  const symbolLookupByUri = new Map<string, Map<string, CompletionSymbolLookup>>();

  occurrencesByUri.forEach((occurrences, uri) => {
    const filePath = path.resolve(toFilePath(uri));
    const lineIndex = lineIndexByFile.get(filePath);
    const byModuleId = new Map<string, SymbolLookupState>();

    occurrences.forEach((occurrence) => {
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

const buildExportEntriesByFirstCharacter = ({
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
