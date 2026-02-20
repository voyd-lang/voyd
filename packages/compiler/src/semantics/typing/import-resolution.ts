import { createTypingContextFromTypingResult } from "./context-from-typing-result.js";
import type { DependencySemantics, TypingContext } from "./types.js";
import type { SymbolId } from "../ids.js";
import type { ModuleExportEntry } from "../modules.js";
import { canonicalSymbolRefForTypingContext } from "./symbol-ref-utils.js";

export type ImportTarget = { moduleId: string; symbol: SymbolId };

export const importTargetFor = (
  symbol: SymbolId,
  ctx: TypingContext,
): ImportTarget | undefined => {
  const mapped = ctx.importsByLocal.get(symbol);
  if (mapped) {
    return mapped;
  }

  const canonical = canonicalSymbolRefForTypingContext(symbol, ctx);
  return canonical.moduleId === ctx.moduleId ? undefined : canonical;
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
