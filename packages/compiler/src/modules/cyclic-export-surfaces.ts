import { isForm } from "../parser/index.js";
import type { ModuleGraph, ModuleNode } from "./types.js";
import type { SymbolKind } from "../semantics/binder/types.js";
import type { HirVisibility } from "../semantics/hir/index.js";
import { maxVisibility } from "../semantics/hir/index.js";
import type { ModuleExportSurfaceTable } from "../semantics/modules.js";
import { packageIdFromPath } from "../semantics/packages.js";
import {
  parseEffectDecl,
  parseFunctionDecl,
  parseModuleLetDecl,
  parseObjectDecl,
  parseTraitDecl,
  parseTypeAliasDecl,
} from "../semantics/binding/parsing.js";

export const collectCyclicModuleExportSurfaces = ({
  graph,
  moduleIds,
  includeTests,
  onSurfaceError,
}: {
  graph: ModuleGraph;
  moduleIds: readonly string[];
  includeTests?: boolean;
  onSurfaceError?: (details: { module: ModuleNode; error: unknown }) => void;
}): Map<string, ModuleExportSurfaceTable> => {
  const tables = new Map<string, ModuleExportSurfaceTable>();

  moduleIds.forEach((moduleId) => {
    const module = graph.modules.get(moduleId);
    if (!module) {
      return;
    }
    tables.set(
      moduleId,
      collectModuleExportSurface({
        module,
        includeTests,
        onSurfaceError,
      }),
    );
  });

  return tables;
};

const collectModuleExportSurface = ({
  module,
  includeTests,
  onSurfaceError,
}: {
  module: ModuleNode;
  includeTests?: boolean;
  onSurfaceError?: (details: { module: ModuleNode; error: unknown }) => void;
}): ModuleExportSurfaceTable => {
  const table: ModuleExportSurfaceTable = new Map();
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
        upsertSurfaceExport({
          table,
          name: functionDecl.signature.name.value,
          kind: "value",
          visibility: functionDecl.visibility,
          module,
          packageId,
        });
        return;
      }

      const moduleLetDecl = parseModuleLetDecl(entry);
      if (moduleLetDecl) {
        upsertSurfaceExport({
          table,
          name: moduleLetDecl.name.value,
          kind: "value",
          visibility: moduleLetDecl.visibility,
          module,
          packageId,
        });
        return;
      }

      const objectDecl = parseObjectDecl(entry);
      if (objectDecl) {
        upsertSurfaceExport({
          table,
          name: objectDecl.name.value,
          kind: "type",
          visibility: objectDecl.visibility,
          module,
          packageId,
        });
        return;
      }

      const typeAliasDecl = parseTypeAliasDecl(entry);
      if (typeAliasDecl) {
        upsertSurfaceExport({
          table,
          name: typeAliasDecl.name.value,
          kind: "type",
          visibility: typeAliasDecl.visibility,
          module,
          packageId,
        });
        return;
      }

      const traitDecl = parseTraitDecl(entry);
      if (traitDecl) {
        upsertSurfaceExport({
          table,
          name: traitDecl.name.value,
          kind: "trait",
          visibility: traitDecl.visibility,
          module,
          packageId,
        });
        return;
      }

      const effectDecl = parseEffectDecl(entry);
      if (effectDecl) {
        upsertSurfaceExport({
          table,
          name: effectDecl.name.value,
          kind: "effect",
          visibility: effectDecl.visibility,
          module,
          packageId,
        });
        effectDecl.operations.forEach((operation) => {
          upsertSurfaceExport({
            table,
            name: operation.name.value,
            kind: "effect-op",
            visibility: effectDecl.visibility,
            module,
            packageId,
          });
        });
      }
    } catch (error) {
      onSurfaceError?.({ module, error });
    }
  });

  return table;
};

const isTestEntry = (form: { attributes?: Record<string, unknown> }): boolean =>
  Boolean(form.attributes?.test);

const upsertSurfaceExport = ({
  table,
  name,
  kind,
  visibility,
  module,
  packageId,
}: {
  table: ModuleExportSurfaceTable;
  name: string;
  kind: SymbolKind;
  visibility: HirVisibility;
  module: ModuleNode;
  packageId: string;
}): void => {
  const existing = table.get(name);
  table.set(name, {
    name,
    moduleId: module.id,
    modulePath: module.path,
    packageId,
    kind: existing?.kind ?? kind,
    visibility: existing
      ? maxVisibility(existing.visibility, visibility)
      : visibility,
  });
};
