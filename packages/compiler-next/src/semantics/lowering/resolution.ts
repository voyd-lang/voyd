import type { LowerContext, IdentifierResolution } from "./types.js";
import type { ScopeId, SymbolId } from "../ids.js";
import {
  intrinsicTypeMetadataFor,
  intrinsicValueMetadataFor,
} from "../intrinsics.js";

export const resolveIdentifierValue = (
  name: string,
  scope: ScopeId,
  ctx: LowerContext
): IdentifierResolution => {
  const resolved = ctx.symbolTable.resolve(name, scope);
  if (typeof resolved !== "number") {
    const intrinsic = resolveIntrinsicSymbol(name, ctx);
    if (typeof intrinsic === "number") {
      return { kind: "symbol", name, symbol: intrinsic };
    }
    return {
      kind: "symbol",
      name,
      symbol: declareUnresolvedSymbol(name, ctx),
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

  const intrinsic = resolveIntrinsicSymbol(name, ctx);
  if (typeof intrinsic === "number") {
    return intrinsic;
  }

  return declareUnresolvedSymbol(name, ctx);
};

export const resolveTypeSymbol = (
  name: string,
  scope: ScopeId,
  ctx: LowerContext
): SymbolId | undefined => {
  const resolved = ctx.symbolTable.resolve(name, scope);
  if (typeof resolved === "number") {
    const record = ctx.symbolTable.getSymbol(resolved);
    if (
      record.kind === "type" ||
      record.kind === "type-parameter" ||
      record.kind === "trait"
    ) {
      return resolved;
    }
  }
  return resolveIntrinsicTypeSymbol(name, ctx);
};

const resolveIntrinsicSymbol = (
  name: string,
  ctx: LowerContext
): SymbolId | undefined => {
  let intrinsic = ctx.intrinsicSymbols.get(name);
  if (typeof intrinsic === "number") {
    return intrinsic;
  }

  const metadata = intrinsicValueMetadataFor(name);
  if (!metadata) {
    return undefined;
  }

  intrinsic = ctx.symbolTable.declare({
    name,
    kind: "value",
    declaredAt: ctx.moduleNodeId,
    metadata: { intrinsic: true, ...metadata },
  });
  ctx.intrinsicSymbols.set(name, intrinsic);
  return intrinsic;
};

const resolveIntrinsicTypeSymbol = (
  name: string,
  ctx: LowerContext
): SymbolId | undefined => {
  const intrinsic = intrinsicTypeMetadataFor(name);
  if (!intrinsic) {
    return undefined;
  }
  const existing = ctx.intrinsicTypeSymbols.get(name);
  if (typeof existing === "number") {
    return existing;
  }

  const symbol = ctx.symbolTable.declare({
    name,
    kind: "type",
    declaredAt: ctx.moduleNodeId,
    metadata: intrinsic,
  });
  ctx.intrinsicTypeSymbols.set(name, symbol);
  return symbol;
};

const declareUnresolvedSymbol = (
  name: string,
  ctx: LowerContext
): SymbolId =>
  ctx.symbolTable.declare({
    name,
    kind: "value",
    declaredAt: ctx.moduleNodeId,
    metadata: { unresolved: true },
  });
