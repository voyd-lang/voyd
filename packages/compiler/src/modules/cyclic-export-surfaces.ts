import { type SurfaceModuleItem } from "../parser/surface/index.js";
import { requireModuleSurface } from "./views.js";
import type { ModuleGraph, ModuleNode } from "./types.js";
import type { SymbolKind } from "../semantics/binder/types.js";
import type { HirVisibility } from "../semantics/hir/index.js";
import { maxVisibility } from "../semantics/hir/index.js";
import type { ModuleExportSurfaceTable } from "../semantics/modules.js";
import { packageIdFromPath } from "../semantics/packages.js";

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

  const surface = requireModuleSurface(module);
  surface.issues.forEach((issue) =>
    onSurfaceError?.({ module, error: new Error(issue.message) }),
  );
  surface.items.forEach((item) => {
    const entry = surfaceItemForm(item);
    if (!includeTests && isTestEntry(entry)) {
      return;
    }

    if (item.kind === "function") {
      const functionDecl = item.declaration;
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

    if (item.kind === "module-let") {
      const moduleLetDecl = item.declaration;
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

    if (item.kind === "object") {
      const objectDecl = item.declaration;
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

    if (item.kind === "type-alias") {
      const typeAliasDecl = item.declaration;
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

    if (item.kind === "trait") {
      const traitDecl = item.declaration;
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

    if (item.kind === "effect") {
      const effectDecl = item.declaration;
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
  });

  return table;
};

const surfaceItemForm = (item: SurfaceModuleItem) =>
  "form" in item ? item.form : item.declaration.form;

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
