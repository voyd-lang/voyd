import type { LowerContext, IdentifierResolution } from "./types.js";
import type { ScopeId, SymbolId } from "../ids.js";

export const resolveIdentifierValue = (
  name: string,
  scope: ScopeId,
  ctx: LowerContext
): IdentifierResolution => {
  const resolved = ctx.symbolTable.resolve(name, scope);
  if (typeof resolved !== "number") {
    return {
      kind: "symbol",
      name,
      symbol: resolveIntrinsicSymbol(name, ctx),
    };
  }

  const overloadSetId = ctx.overloadBySymbol.get(resolved);
  if (typeof overloadSetId === "number") {
    return { kind: "overload-set", name, set: overloadSetId };
  }

  return { kind: "symbol", name, symbol: resolved };
};

export const resolveSymbol = (
  name: string,
  scope: ScopeId,
  ctx: LowerContext
): SymbolId => {
  const resolved = ctx.symbolTable.resolve(name, scope);
  if (typeof resolved === "number") {
    return resolved;
  }

  return resolveIntrinsicSymbol(name, ctx);
};

export const resolveTypeSymbol = (
  name: string,
  scope: ScopeId,
  ctx: LowerContext
): SymbolId | undefined => {
  const resolved = ctx.symbolTable.resolve(name, scope);
  if (typeof resolved !== "number") {
    return undefined;
  }
  const record = ctx.symbolTable.getSymbol(resolved);
  if (
    record.kind === "type" ||
    record.kind === "type-parameter" ||
    record.kind === "trait"
  ) {
    return resolved;
  }
  return undefined;
};

const resolveIntrinsicSymbol = (name: string, ctx: LowerContext): SymbolId => {
  let intrinsic = ctx.intrinsicSymbols.get(name);
  if (typeof intrinsic === "number") {
    return intrinsic;
  }

  intrinsic = ctx.symbolTable.declare({
    name,
    kind: "value",
    declaredAt: ctx.moduleNodeId,
    metadata: { intrinsic: true },
  });
  ctx.intrinsicSymbols.set(name, intrinsic);
  return intrinsic;
};
