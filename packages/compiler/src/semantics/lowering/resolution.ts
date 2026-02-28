import type { LowerContext, IdentifierResolution } from "./types.js";
import type { ScopeId, SymbolId } from "../ids.js";
import {
  intrinsicTypeMetadataFor,
  intrinsicValueMetadataFor,
} from "../intrinsics.js";

const isImportedSymbol = (symbol: SymbolId, ctx: LowerContext): boolean => {
  const record = ctx.symbolTable.getSymbol(symbol);
  const metadata = record.metadata as { import?: unknown } | undefined;
  return metadata?.import !== undefined;
};

const resolveValueSymbol = ({
  identifier,
  scope,
  ctx,
}: {
  identifier: { name: string; isQuoted: boolean };
  scope: ScopeId;
  ctx: LowerContext;
}): SymbolId | undefined => {
  let currentScope: ScopeId | null = scope;
  while (currentScope !== null) {
    const matches = Array.from(ctx.symbolTable.symbolsInScope(currentScope))
      .map((symbol) => ({ symbol, record: ctx.symbolTable.getSymbol(symbol) }))
      .filter(({ record }) => {
        if (record.name !== identifier.name || record.kind === "effect-op") {
          return false;
        }
        const meta = (record.metadata ?? {}) as { quotedName?: boolean };
        const declQuoted = meta.quotedName === true;
        return identifier.isQuoted ? declQuoted : !declQuoted;
      });

    if (matches.length > 0) {
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        const candidate = matches[index]!;
        if (!isImportedSymbol(candidate.symbol, ctx)) {
          return candidate.symbol;
        }
      }

      for (let index = matches.length - 1; index >= 0; index -= 1) {
        const candidate = matches[index]!;
        if (isImportedSymbol(candidate.symbol, ctx)) {
          return candidate.symbol;
        }
      }
    }

    currentScope = ctx.symbolTable.getScope(currentScope).parent;
  }

  return undefined;
};

export const resolveIdentifierValue = (
  identifier: { name: string; isQuoted: boolean },
  scope: ScopeId,
  ctx: LowerContext
): IdentifierResolution => {
  const name = identifier.name;
  const resolved = resolveValueSymbol({ identifier, scope, ctx });
  if (typeof resolved === "number") {
    const record = ctx.symbolTable.getSymbol(resolved);
    if (record.kind === "type") {
      const constructorResolution = resolveConstructorResolution({
        targetSymbol: resolved,
        name,
        ctx,
      });
      if (constructorResolution) {
        return constructorResolution;
      }
    }
  }
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
  if (metadata.access === "std-only" && ctx.packageId !== "std") {
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

export const resolveConstructorResolution = ({
  targetSymbol,
  name,
  ctx,
}: {
  targetSymbol: SymbolId;
  name: string;
  ctx: LowerContext;
}): IdentifierResolution | undefined => {
  const constructors = ctx.staticMethods.get(targetSymbol)?.get("init");
  if (!constructors || constructors.size === 0) {
    return undefined;
  }

  const symbols = Array.from(constructors);
  const overloadIds = new Set(
    symbols
      .map((symbol) => ctx.overloadBySymbol.get(symbol))
      .filter((entry): entry is number => typeof entry === "number")
  );

  if (symbols.length === 1) {
    const [symbol] = symbols;
    if (overloadIds.size === 1) {
      return {
        kind: "overload-set",
        name,
        set: overloadIds.values().next().value as number,
      };
    }
    return { kind: "symbol", name, symbol };
  }

  if (overloadIds.size === 1) {
    return {
      kind: "overload-set",
      name,
      set: overloadIds.values().next().value as number,
    };
  }

  throw new Error(`ambiguous constructor overloads for type ${name}`);
};
