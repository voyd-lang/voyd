import { importedSymbolTargetFromMetadata } from "../enum-namespace.js";
import { isPackageVisible, isPublicVisibility } from "../hir/index.js";
import type { SymbolId } from "../ids.js";
import { importedModuleIdFrom } from "../imports/metadata.js";
import type { ModuleExportEntry } from "../modules.js";
import { isSamePackage } from "../packages.js";
import type { BindingContext } from "./types.js";

export const stdPkgExportsFor = ({
  moduleId,
  ctx,
}: {
  moduleId: string;
  ctx: BindingContext;
}): Map<string, ModuleExportEntry> | undefined => {
  const stdPkgExports = ctx.moduleExports.get("std::pkg");
  if (!stdPkgExports) {
    return undefined;
  }

  const filtered = new Map<string, ModuleExportEntry>();
  for (const entry of stdPkgExports.values()) {
    if (!isPublicVisibility(entry.visibility)) {
      continue;
    }
    const target = exportTargetFor(entry, ctx);
    if (!target) {
      continue;
    }
    if (
      isSameOrDescendantModuleId(target.moduleId, moduleId) ||
      isSameOrDescendantModuleId(moduleId, target.moduleId)
    ) {
      filtered.set(entry.name, entry);
    }
  }

  return filtered.size > 0 ? filtered : undefined;
};

export const canAccessExport = ({
  exported,
  moduleId,
  ctx,
  allowStdSubmodulePackageExports = false,
}: {
  exported: ModuleExportEntry;
  moduleId: string;
  ctx: BindingContext;
  allowStdSubmodulePackageExports?: boolean;
}): boolean => {
  if (moduleId === ctx.module.id) {
    return true;
  }

  const isStdPkgExported = (): boolean => {
    if (exported.packageId !== "std") {
      return false;
    }
    const target = exportTargetFor(exported, ctx);
    return target
      ? isStdPkgExportedTarget({ target, importedFromModuleId: moduleId, ctx })
      : false;
  };

  const samePackage =
    exported.packageId === ctx.packageId ||
    isSamePackage(exported.modulePath, ctx.modulePath);

  if (samePackage) {
    return isPackageVisible(exported.visibility);
  }

  if (
    allowStdSubmodulePackageExports &&
    exported.packageId === "std" &&
    moduleId.startsWith("std::") &&
    moduleId !== "std::pkg"
  ) {
    return isPackageVisible(exported.visibility);
  }

  if (isPublicVisibility(exported.visibility)) {
    return true;
  }

  return isStdPkgExported();
};

const exportTargetFor = (
  entry: ModuleExportEntry,
  ctx: BindingContext,
): { moduleId: string; symbol: SymbolId } | undefined => {
  const dependency = ctx.dependencies.get(entry.moduleId);
  if (!dependency) {
    return { moduleId: entry.moduleId, symbol: entry.symbol };
  }

  const sourceMetadata = dependency.symbolTable.getSymbol(entry.symbol)
    .metadata as Record<string, unknown> | undefined;
  if (entry.kind === "module") {
    const moduleId = importedModuleIdFrom(sourceMetadata);
    if (moduleId) {
      return { moduleId, symbol: entry.symbol };
    }
  }
  const imported = importedSymbolTargetFromMetadata(sourceMetadata);
  if (imported) {
    return imported;
  }
  return { moduleId: entry.moduleId, symbol: entry.symbol };
};

const isSameOrDescendantModuleId = (moduleId: string, parent: string): boolean =>
  moduleId === parent || moduleId.startsWith(`${parent}::`);

const isStdPkgExportedTarget = ({
  target,
  importedFromModuleId,
  ctx,
}: {
  target: { moduleId: string; symbol: SymbolId };
  importedFromModuleId: string;
  ctx: BindingContext;
}): boolean => {
  const exports = stdPkgExportsFor({ moduleId: importedFromModuleId, ctx });
  if (!exports) {
    return false;
  }
  for (const entry of exports.values()) {
    const entryTarget = exportTargetFor(entry, ctx);
    if (!entryTarget) {
      continue;
    }
    if (
      entry.kind === "module" &&
      isSameOrDescendantModuleId(importedFromModuleId, entryTarget.moduleId)
    ) {
      return true;
    }
    if (
      entryTarget.moduleId === target.moduleId &&
      entryTarget.symbol === target.symbol
    ) {
      return true;
    }
  }
  return false;
};
