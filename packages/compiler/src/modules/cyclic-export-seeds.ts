import { isForm } from "../parser/index.js";
import type { ModuleGraph, ModuleNode } from "./types.js";
import type { SymbolKind } from "../semantics/binder/types.js";
import type { HirVisibility } from "../semantics/hir/index.js";
import { maxVisibility } from "../semantics/hir/index.js";
import type { SymbolId } from "../semantics/ids.js";
import type { ModuleExportTable } from "../semantics/modules.js";
import { packageIdFromPath } from "../semantics/packages.js";
import {
  parseEffectDecl,
  parseFunctionDecl,
  parseModuleLetDecl,
  parseObjectDecl,
  parseTraitDecl,
  parseTypeAliasDecl,
} from "../semantics/binding/parsing.js";

type SeedExportState = { nextSyntheticSymbol: number };

export const seedCyclicModuleExports = ({
  graph,
  moduleIds,
  includeTests,
  onSeedError,
}: {
  graph: ModuleGraph;
  moduleIds: readonly string[];
  includeTests?: boolean;
  onSeedError?: (details: { module: ModuleNode; error: unknown }) => void;
}): Map<string, ModuleExportTable> => {
  const state: SeedExportState = { nextSyntheticSymbol: -1 };
  const tables = new Map<string, ModuleExportTable>();

  moduleIds.forEach((moduleId) => {
    const module = graph.modules.get(moduleId);
    if (!module) {
      return;
    }
    tables.set(
      moduleId,
      seedModuleExports({
        module,
        state,
        includeTests,
        onSeedError,
      }),
    );
  });

  return tables;
};

const seedModuleExports = ({
  module,
  state,
  includeTests,
  onSeedError,
}: {
  module: ModuleNode;
  state: SeedExportState;
  includeTests?: boolean;
  onSeedError?: (details: { module: ModuleNode; error: unknown }) => void;
}): ModuleExportTable => {
  const table: ModuleExportTable = new Map();
  const packageId = packageIdFromPath(module.path, {
    sourcePackageRoot: module.sourcePackageRoot,
  });

  module.ast.rest.forEach((entry) => {
    if (!isForm(entry)) {
      return;
    }
    if (!includeTests && isTestEntry(entry)) {
      return;
    }

    try {
      const functionDecl = parseFunctionDecl(entry);
      if (functionDecl) {
        upsertSeedExport({
          table,
          name: functionDecl.signature.name.value,
          kind: "value",
          visibility: functionDecl.visibility,
          module,
          packageId,
          symbol: nextSyntheticSymbol(state),
        });
        return;
      }

      const moduleLetDecl = parseModuleLetDecl(entry);
      if (moduleLetDecl) {
        upsertSeedExport({
          table,
          name: moduleLetDecl.name.value,
          kind: "value",
          visibility: moduleLetDecl.visibility,
          module,
          packageId,
          symbol: nextSyntheticSymbol(state),
        });
        return;
      }

      const objectDecl = parseObjectDecl(entry);
      if (objectDecl) {
        upsertSeedExport({
          table,
          name: objectDecl.name.value,
          kind: "type",
          visibility: objectDecl.visibility,
          module,
          packageId,
          symbol: nextSyntheticSymbol(state),
        });
        return;
      }

      const typeAliasDecl = parseTypeAliasDecl(entry);
      if (typeAliasDecl) {
        upsertSeedExport({
          table,
          name: typeAliasDecl.name.value,
          kind: "type",
          visibility: typeAliasDecl.visibility,
          module,
          packageId,
          symbol: nextSyntheticSymbol(state),
        });
        return;
      }

      const traitDecl = parseTraitDecl(entry);
      if (traitDecl) {
        upsertSeedExport({
          table,
          name: traitDecl.name.value,
          kind: "trait",
          visibility: traitDecl.visibility,
          module,
          packageId,
          symbol: nextSyntheticSymbol(state),
        });
        return;
      }

      const effectDecl = parseEffectDecl(entry);
      if (effectDecl) {
        const effectSymbol = nextSyntheticSymbol(state);
        upsertSeedExport({
          table,
          name: effectDecl.name.value,
          kind: "effect",
          visibility: effectDecl.visibility,
          module,
          packageId,
          symbol: effectSymbol,
        });
        effectDecl.operations.forEach((operation) => {
          upsertSeedExport({
            table,
            name: operation.name.value,
            kind: "effect-op",
            visibility: effectDecl.visibility,
            module,
            packageId,
            symbol: nextSyntheticSymbol(state),
            memberOwner: effectSymbol,
          });
        });
      }
    } catch (error) {
      onSeedError?.({ module, error });
    }
  });

  return table;
};

const nextSyntheticSymbol = (state: SeedExportState): SymbolId =>
  (state.nextSyntheticSymbol-- as SymbolId);

const isTestEntry = (form: { attributes?: Record<string, unknown> }): boolean =>
  Boolean(form.attributes?.test);

const upsertSeedExport = ({
  table,
  name,
  kind,
  visibility,
  module,
  packageId,
  symbol,
  memberOwner,
}: {
  table: ModuleExportTable;
  name: string;
  kind: SymbolKind;
  visibility: HirVisibility;
  module: ModuleNode;
  packageId: string;
  symbol: SymbolId;
  memberOwner?: SymbolId;
}): void => {
  const existing = table.get(name);
  const symbols = existing
    ? new Set(existing.symbols ?? [existing.symbol])
    : new Set<SymbolId>();
  symbols.add(symbol);
  table.set(name, {
    name,
    symbol: existing?.symbol ?? symbol,
    symbols: Array.from(symbols),
    moduleId: module.id,
    modulePath: module.path,
    packageId,
    kind: existing?.kind ?? kind,
    visibility: existing
      ? maxVisibility(existing.visibility, visibility)
      : visibility,
    memberOwner: existing?.memberOwner ?? memberOwner,
  });
};
