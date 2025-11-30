import type { LowerContext, IdentifierResolution } from "./types.js";
import type { ScopeId, SymbolId } from "../ids.js";

const INTRINSIC_TYPES = new Map<
  string,
  { metadata: Record<string, unknown> }
>([
  [
    "FixedArray",
    { metadata: { intrinsic: true, intrinsicType: "fixed-array", arity: 1 } },
  ],
]);

const INTRINSIC_VALUES = new Map<
  string,
  { metadata: Record<string, unknown> }
>([
  [
    "fixed_array_literal",
    {
      metadata: {
        intrinsic: true,
        intrinsicName: "__array_new_fixed",
        intrinsicUsesSignature: false,
      },
    },
  ],
]);

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

const resolveIntrinsicSymbol = (name: string, ctx: LowerContext): SymbolId => {
  let intrinsic = ctx.intrinsicSymbols.get(name);
  if (typeof intrinsic === "number") {
    return intrinsic;
  }

  const { metadata: intrinsicMetadata = {} } =
    INTRINSIC_VALUES.get(name) ?? {};

  intrinsic = ctx.symbolTable.declare({
    name,
    kind: "value",
    declaredAt: ctx.moduleNodeId,
    metadata: { intrinsic: true, ...intrinsicMetadata },
  });
  ctx.intrinsicSymbols.set(name, intrinsic);
  return intrinsic;
};

const resolveIntrinsicTypeSymbol = (
  name: string,
  ctx: LowerContext
): SymbolId | undefined => {
  const intrinsic = INTRINSIC_TYPES.get(name);
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
    metadata: intrinsic.metadata,
  });
  ctx.intrinsicTypeSymbols.set(name, symbol);
  return symbol;
};
