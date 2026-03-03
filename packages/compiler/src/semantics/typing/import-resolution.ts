import { createTypingContextFromTypingResult } from "./context-from-typing-result.js";
import type { DependencySemantics, TypingContext } from "./types.js";
import type { SymbolId } from "../ids.js";
import type { ModuleExportEntry } from "../modules.js";
import {
  canonicalSymbolRefForTypingContext,
  canonicalSymbolRefInTypingContext,
} from "./symbol-ref-utils.js";

export type ImportTarget = { moduleId: string; symbol: SymbolId };

export const importTargetFor = (
  symbol: SymbolId,
  ctx: TypingContext,
): ImportTarget | undefined => {
  const mapped = ctx.importsByLocal.get(symbol);
  if (mapped) {
    return mapped;
  }

  const metadataTarget = importTargetFromMetadata({ symbol, ctx });
  if (metadataTarget) {
    const canonicalTarget = canonicalSymbolRefInTypingContext(metadataTarget, ctx);
    ctx.importsByLocal.set(symbol, canonicalTarget);
    const bucket =
      ctx.importAliasesByModule.get(canonicalTarget.moduleId) ?? new Map();
    bucket.set(canonicalTarget.symbol, symbol);
    ctx.importAliasesByModule.set(canonicalTarget.moduleId, bucket);
    return canonicalTarget;
  }

  const canonical = canonicalSymbolRefForTypingContext(symbol, ctx);
  return canonical.moduleId === ctx.moduleId ? undefined : canonical;
};

type ImportMetadata = {
  import?: { moduleId?: unknown; symbol?: unknown };
};

const importTargetFromMetadata = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: TypingContext;
}): ImportTarget | undefined => {
  const record = ctx.symbolTable.getSymbol(symbol);
  const metadata = (record.metadata ?? {}) as ImportMetadata;
  const importModuleId = metadata.import?.moduleId;
  const importSymbol = metadata.import?.symbol;
  if (typeof importModuleId !== "string") {
    return undefined;
  }
  if (typeof importSymbol === "number") {
    return { moduleId: importModuleId, symbol: importSymbol };
  }
  if (record.kind === "module") {
    return undefined;
  }

  const dependency = ctx.dependencies.get(importModuleId);
  if (!dependency) {
    return undefined;
  }
  const exportEntry = dependency.exports.get(record.name);
  if (!exportEntry) {
    return undefined;
  }

  const candidates =
    exportEntry.symbols && exportEntry.symbols.length > 0
      ? exportEntry.symbols
      : [exportEntry.symbol];
  const byKind = candidates.find((candidate) => {
    try {
      return dependency.symbolTable.getSymbol(candidate).kind === record.kind;
    } catch {
      return false;
    }
  });
  const resolved = byKind ?? candidates[0];
  return typeof resolved === "number"
    ? { moduleId: importModuleId, symbol: resolved }
    : undefined;
};

export const mapLocalSymbolToDependency = ({
  owner,
  dependency,
  ctx,
}: {
  owner: SymbolId;
  dependency: DependencySemantics;
  ctx: TypingContext;
}): SymbolId => {
  const canonical = canonicalSymbolRefForTypingContext(owner, ctx);
  if (canonical.moduleId === dependency.moduleId) {
    return canonical.symbol;
  }

  const record = ctx.symbolTable.getSymbol(owner);
  throw new Error(
    `type parameter or symbol ${record.name} is not available in ${dependency.moduleId}`,
  );
};

export const findExport = (
  symbol: SymbolId,
  dependency: DependencySemantics,
): ModuleExportEntry | undefined =>
  Array.from(dependency.exports.values()).find(
    (entry) =>
      entry.symbol === symbol || entry.symbols?.some((sym) => sym === symbol),
  );

export const makeDependencyContext = (
  dependency: DependencySemantics,
  ctx: TypingContext,
): TypingContext =>
  createTypingContextFromTypingResult({
    symbolTable: dependency.symbolTable,
    hir: dependency.hir,
    overloads: dependency.overloads,
    typeCheckBudget: ctx.typeCheckBudget,
    decls: dependency.decls,
    moduleId: dependency.moduleId,
    packageId: dependency.packageId,
    moduleExports: ctx.moduleExports,
    dependencies: ctx.dependencies,
    importsByLocal: new Map(),
    importAliasesByModule: new Map(),
    typing: dependency.typing,
  });
