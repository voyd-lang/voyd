import type { SymbolKind, SymbolRecord } from "../binder/index.js";
import type { ScopeId, SourceSpan, SymbolId } from "../ids.js";
import { toSourceSpan } from "../utils.js";
import type { BindingContext } from "./types.js";

type ScopeSymbol = {
  symbolId: SymbolId;
  record: SymbolRecord;
  span: SourceSpan;
};

export type BindingNameCollision = {
  symbolId: SymbolId;
  kind: SymbolKind;
  span: SourceSpan;
};

const symbolsNamedInScope = ({
  name,
  scope,
  ctx,
  skipSymbol,
}: {
  name: string;
  scope: ScopeId;
  ctx: BindingContext;
  skipSymbol?: SymbolId;
}): ScopeSymbol[] => {
  const symbols: ScopeSymbol[] = [];
  for (const symbolId of ctx.symbolTable.symbolsInScope(scope)) {
    if (symbolId === skipSymbol) {
      continue;
    }
    const record = ctx.symbolTable.getSymbol(symbolId);
    if (record.name !== name) {
      continue;
    }
    symbols.push({
      symbolId,
      record,
      span: spanForDeclaredSymbol({ symbol: symbolId, ctx }),
    });
  }
  return symbols;
};

const overloadEntity = (record: SymbolRecord): string | undefined => {
  const metadata = (record.metadata ?? {}) as { entity?: string };
  return metadata.entity;
};

const overloadAllowsSymbol = (record: SymbolRecord): boolean => {
  const entity = overloadEntity(record);
  return entity === "function" || entity === "object";
};

const isModuleNamespaceCollision = ({
  existingKind,
  incomingKind,
}: {
  existingKind: SymbolKind;
  incomingKind: SymbolKind;
}): boolean =>
  (existingKind === "module" && incomingKind !== "module") ||
  (existingKind !== "module" && incomingKind === "module");

export const findNonOverloadNameCollision = ({
  name,
  scope,
  skipSymbol,
  ctx,
}: {
  name: string;
  scope: ScopeId;
  skipSymbol?: SymbolId;
  ctx: BindingContext;
}): BindingNameCollision | undefined => {
  const symbols = symbolsNamedInScope({ name, scope, skipSymbol, ctx });
  const conflict = symbols.find((entry) => !overloadAllowsSymbol(entry.record));
  if (!conflict) {
    return undefined;
  }
  return {
    symbolId: conflict.symbolId,
    kind: conflict.record.kind,
    span: conflict.span,
  };
};

export const findModuleNamespaceNameCollision = ({
  name,
  scope,
  incomingKind,
  ctx,
}: {
  name: string;
  scope: ScopeId;
  incomingKind: SymbolKind;
  ctx: BindingContext;
}): BindingNameCollision | undefined => {
  const symbols = symbolsNamedInScope({ name, scope, ctx });
  const conflict = symbols.find((entry) =>
    isModuleNamespaceCollision({
      existingKind: entry.record.kind,
      incomingKind,
    }),
  );
  if (!conflict) {
    return undefined;
  }
  return {
    symbolId: conflict.symbolId,
    kind: conflict.record.kind,
    span: conflict.span,
  };
};

export const findLocalBindingNameCollision = ({
  name,
  scope,
  ctx,
}: {
  name: string;
  scope: ScopeId;
  ctx: BindingContext;
}): BindingNameCollision | undefined => {
  const symbols = symbolsNamedInScope({ name, scope, ctx });
  const conflict = symbols.find((entry) => isLocalBinding(entry.record));
  if (!conflict) {
    return undefined;
  }
  return {
    symbolId: conflict.symbolId,
    kind: conflict.record.kind,
    span: conflict.span,
  };
};

const isLocalBinding = (record: SymbolRecord): boolean => {
  const metadata = record.metadata as { localBinding?: unknown } | undefined;
  return metadata?.localBinding === true;
};

export const spanForDeclaredSymbol = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: BindingContext;
}): SourceSpan => {
  const declaredAt = ctx.symbolTable.getSymbol(symbol).declaredAt;
  return toSourceSpan(ctx.syntaxByNode.get(declaredAt));
};
