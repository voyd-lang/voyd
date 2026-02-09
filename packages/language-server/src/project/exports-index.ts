import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  modulePathFromFile,
  modulePathToString,
} from "@voyd/compiler/modules/path.js";
import { createNodePathAdapter } from "@voyd/compiler/modules/node-path-adapter.js";
import type { ModuleRoots } from "@voyd/compiler/modules/types.js";
import type { SemanticsPipelineResult } from "@voyd/compiler/semantics/pipeline.js";
import { collectVoydFiles } from "./files.js";
import { scanExportsFromSource } from "./export-scan.js";
import type { ExportCandidate } from "./types.js";

type WorkspaceExportState = {
  roots: ModuleRoots;
  srcRoot: string;
  exportsByFile: Map<string, ExportCandidate[]>;
  exportsByName: Map<string, ExportCandidate[]>;
};

const candidateKey = (candidate: ExportCandidate): string =>
  `${candidate.moduleId}:${candidate.name}:${candidate.kind}:${candidate.symbol}`;

const isWithinRoot = ({
  filePath,
  rootPath,
}: {
  filePath: string;
  rootPath: string;
}): boolean => {
  const relative = path.relative(rootPath, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const addCandidate = ({
  map,
  candidate,
}: {
  map: Map<string, ExportCandidate[]>;
  candidate: ExportCandidate;
}): void => {
  const existing = map.get(candidate.name) ?? [];
  const exists = existing.some((entry) => candidateKey(entry) === candidateKey(candidate));
  if (exists) {
    return;
  }
  existing.push(candidate);
  map.set(candidate.name, existing);
};

const removeCandidate = ({
  map,
  candidate,
}: {
  map: Map<string, ExportCandidate[]>;
  candidate: ExportCandidate;
}): void => {
  const existing = map.get(candidate.name);
  if (!existing) {
    return;
  }
  const filtered = existing.filter((entry) => candidateKey(entry) !== candidateKey(candidate));
  if (filtered.length === 0) {
    map.delete(candidate.name);
    return;
  }
  map.set(candidate.name, filtered);
};

const exportsFromSemantics = ({
  semantics,
}: {
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
}): Map<string, ExportCandidate[]> => {
  const exportsByName = new Map<string, ExportCandidate[]>();

  semantics.forEach((entry, moduleId) => {
    entry.exports.forEach((exported) => {
      addCandidate({
        map: exportsByName,
        candidate: {
          moduleId,
          symbol: exported.symbol,
          name: exported.name,
          kind: exported.kind,
        },
      });
    });
  });

  return exportsByName;
};

export const mergeExportIndexes = ({
  primary,
  secondary,
}: {
  primary: ReadonlyMap<string, readonly ExportCandidate[]>;
  secondary: ReadonlyMap<string, readonly ExportCandidate[]>;
}): Map<string, ExportCandidate[]> => {
  const merged = new Map<string, ExportCandidate[]>();

  primary.forEach((candidates, name) => {
    candidates.forEach((candidate) => {
      addCandidate({
        map: merged,
        candidate: {
          moduleId: candidate.moduleId,
          symbol: candidate.symbol,
          name: candidate.name,
          kind: candidate.kind,
        },
      });
    });
    if (!merged.has(name)) {
      merged.set(name, []);
    }
  });

  secondary.forEach((candidates) => {
    candidates.forEach((candidate) => addCandidate({ map: merged, candidate }));
  });

  return merged;
};

export const buildSemanticsExportIndex = ({
  semantics,
}: {
  semantics: ReadonlyMap<string, SemanticsPipelineResult>;
}): ReadonlyMap<string, readonly ExportCandidate[]> =>
  exportsFromSemantics({ semantics });

export class IncrementalExportIndex {
  readonly #statesBySrcRoot = new Map<string, WorkspaceExportState>();
  readonly #pathAdapter = createNodePathAdapter();

  async ensureInitialized({
    roots,
    openDocuments,
  }: {
    roots: ModuleRoots;
    openDocuments: ReadonlyMap<string, string>;
  }): Promise<void> {
    if (!roots.src) {
      return;
    }

    const srcRoot = path.resolve(roots.src);
    if (this.#statesBySrcRoot.has(srcRoot)) {
      return;
    }

    const state: WorkspaceExportState = {
      roots,
      srcRoot,
      exportsByFile: new Map(),
      exportsByName: new Map(),
    };
    this.#statesBySrcRoot.set(srcRoot, state);

    const sourceFiles = await collectVoydFiles(srcRoot).catch(() => []);
    await Promise.all(
      sourceFiles.map(async (filePath) => {
        const normalized = path.resolve(filePath);
        const source =
          openDocuments.get(normalized) ??
          (await readFile(normalized, "utf8").catch(() => undefined));
        if (!source) {
          return;
        }
        this.#setFileExports({
          state,
          filePath: normalized,
          source,
        });
      }),
    );
  }

  updateOpenDocument({
    filePath,
    source,
  }: {
    filePath: string;
    source: string;
  }): void {
    const normalized = path.resolve(filePath);
    this.#statesForFile(normalized).forEach((state) => {
      this.#setFileExports({
        state,
        filePath: normalized,
        source,
      });
    });
  }

  async refreshFromDisk(filePath: string): Promise<void> {
    const normalized = path.resolve(filePath);
    await Promise.all(
      this.#statesForFile(normalized).map(async (state) => {
        const source = await readFile(normalized, "utf8").catch(() => undefined);
        if (!source) {
          this.#clearFileExports({
            state,
            filePath: normalized,
          });
          return;
        }
        this.#setFileExports({
          state,
          filePath: normalized,
          source,
        });
      }),
    );
  }

  deleteFile(filePath: string): void {
    const normalized = path.resolve(filePath);
    this.#statesForFile(normalized).forEach((state) => {
      this.#clearFileExports({
        state,
        filePath: normalized,
      });
    });
  }

  exportsForRoots(roots: ModuleRoots): ReadonlyMap<string, readonly ExportCandidate[]> {
    const srcRoot = roots.src ? path.resolve(roots.src) : "";
    return this.#statesBySrcRoot.get(srcRoot)?.exportsByName ?? new Map();
  }

  #statesForFile(filePath: string): WorkspaceExportState[] {
    return Array.from(this.#statesBySrcRoot.values()).filter((state) =>
      isWithinRoot({ filePath, rootPath: state.srcRoot }),
    );
  }

  #setFileExports({
    state,
    filePath,
    source,
  }: {
    state: WorkspaceExportState;
    filePath: string;
    source: string;
  }): void {
    if (!filePath.endsWith(".voyd")) {
      return;
    }

    this.#clearFileExports({ state, filePath });

    const moduleId = modulePathToString(
      modulePathFromFile(filePath, state.roots, this.#pathAdapter),
    );
    const scanned = scanExportsFromSource(source).map((entry) => ({
      moduleId,
      symbol: -1,
      name: entry.name,
      kind: entry.kind,
    }));

    if (scanned.length === 0) {
      return;
    }

    state.exportsByFile.set(filePath, scanned);
    scanned.forEach((candidate) => {
      addCandidate({
        map: state.exportsByName,
        candidate,
      });
    });
  }

  #clearFileExports({
    state,
    filePath,
  }: {
    state: WorkspaceExportState;
    filePath: string;
  }): void {
    const existing = state.exportsByFile.get(filePath);
    if (!existing) {
      return;
    }
    existing.forEach((candidate) => {
      removeCandidate({
        map: state.exportsByName,
        candidate,
      });
    });
    state.exportsByFile.delete(filePath);
  }
}
