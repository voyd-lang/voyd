import type { Syntax } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import { resolveConstructorResolution } from "../resolution.js";
import type { IdentifierResolution, LowerContext } from "../types.js";
import type { HirExprId, SymbolId } from "../ids.js";

export const lowerResolvedCallee = ({
  resolution,
  syntax,
  ctx,
}: {
  resolution: IdentifierResolution;
  syntax: Syntax;
  ctx: LowerContext;
}): HirExprId => {
  const span = toSourceSpan(syntax);
  if (resolution.kind === "symbol") {
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "identifier",
      ast: syntax.syntaxId,
      span,
      symbol: resolution.symbol,
    });
  }

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "overload-set",
    ast: syntax.syntaxId,
    span,
    name: resolution.name,
    set: resolution.set,
  });
};

export const resolveStaticMethodResolution = ({
  name,
  targetSymbol,
  methodTable,
  ctx,
}: {
  name: string;
  targetSymbol: SymbolId;
  methodTable: ReadonlyMap<string, Set<SymbolId>>;
  ctx: LowerContext;
}): IdentifierResolution => {
  const symbols = methodTable.get(name);
  if (!symbols || symbols.size === 0) {
    const targetName = ctx.symbolTable.getSymbol(targetSymbol).name;
    throw new Error(`type ${targetName} does not declare static method ${name}`);
  }

  if (symbols.size === 1) {
    const symbol = symbols.values().next().value as SymbolId;
    const overload = ctx.overloadBySymbol.get(symbol);
    return typeof overload === "number"
      ? { kind: "overload-set", name, set: overload }
      : { kind: "symbol", name, symbol };
  }

  const symbolsArray = Array.from(symbols);
  let missingOverload = false;
  const overloads = new Set<number>();
  symbolsArray.forEach((symbol) => {
    const overloadId = ctx.overloadBySymbol.get(symbol);
    if (typeof overloadId === "number") {
      overloads.add(overloadId);
      return;
    }
    missingOverload = true;
  });

  if (!missingOverload && overloads.size === 1) {
    return {
      kind: "overload-set",
      name,
      set: overloads.values().next().value as number,
    };
  }

  const targetName = ctx.symbolTable.getSymbol(targetSymbol).name;
  throw new Error(`ambiguous static method ${name} for type ${targetName}`);
};

export const resolveModuleMemberResolution = ({
  name,
  moduleSymbol,
  memberTable,
  ctx,
}: {
  name: string;
  moduleSymbol: SymbolId;
  memberTable: ReadonlyMap<string, Set<SymbolId>>;
  ctx: LowerContext;
}): IdentifierResolution | undefined => {
  const symbols = memberTable.get(name);
  if (!symbols || symbols.size === 0) {
    return undefined;
  }

  if (symbols.size === 1) {
    const symbol = symbols.values().next().value as SymbolId;
    const overload = ctx.overloadBySymbol.get(symbol);
    return typeof overload === "number"
      ? { kind: "overload-set", name, set: overload }
      : { kind: "symbol", name, symbol };
  }

  const overloads = new Set<number>();
  let missing = false;
  symbols.forEach((symbol) => {
    const id = ctx.overloadBySymbol.get(symbol);
    if (typeof id === "number") {
      overloads.add(id);
    } else {
      missing = true;
    }
  });

  if (!missing && overloads.size === 1) {
    return {
      kind: "overload-set",
      name,
      set: overloads.values().next().value as number,
    };
  }

  const moduleName = ctx.symbolTable.getSymbol(moduleSymbol).name;
  throw new Error(`ambiguous module member ${name} on ${moduleName}`);
};

export const resolveModuleMemberCallResolution = ({
  name,
  moduleSymbol,
  memberTable,
  ctx,
}: {
  name: string;
  moduleSymbol: SymbolId;
  memberTable: ReadonlyMap<string, Set<SymbolId>>;
  ctx: LowerContext;
}): IdentifierResolution | undefined => {
  const base = resolveModuleMemberResolution({
    name,
    moduleSymbol,
    memberTable,
    ctx,
  });
  if (!base) {
    return undefined;
  }
  if (base.kind !== "symbol") {
    return base;
  }
  const record = ctx.symbolTable.getSymbol(base.symbol);
  if (record.kind !== "type") {
    return base;
  }
  const constructor = resolveConstructorResolution({
    targetSymbol: base.symbol,
    name,
    ctx,
  });
  return constructor ?? base;
};
