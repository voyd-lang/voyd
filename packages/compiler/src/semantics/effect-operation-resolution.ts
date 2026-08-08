import type { SymbolTable } from "./binder/index.js";
import type { ScopeId, SymbolId } from "./ids.js";

type EffectOperationMemberTable = ReadonlyMap<
  SymbolId,
  ReadonlyMap<string, ReadonlySet<SymbolId>>
>;

export const canonicalEffectIdentitySymbol = ({
  effectSymbol,
  symbolTable,
}: {
  effectSymbol: SymbolId;
  symbolTable: SymbolTable;
}): SymbolId => {
  const imported = importedTargetForSymbol({
    symbol: effectSymbol,
    symbolTable,
  });
  if (!imported) {
    return effectSymbol;
  }

  return (
    Array.from(symbolTable.symbolsInScope(symbolTable.rootScope)).find(
      (candidate) => {
        const record = symbolTable.getSymbol(candidate);
        if (record.kind !== "effect") {
          return false;
        }
        const target = importedTargetForSymbol({
          symbol: candidate,
          symbolTable,
        });
        return (
          target?.moduleId === imported.moduleId &&
          target.symbol === imported.symbol
        );
      },
    ) ?? effectSymbol
  );
};

export const canonicalEffectOperationIdentitySymbol = ({
  operationSymbol,
  symbolTable,
}: {
  operationSymbol: SymbolId;
  symbolTable: SymbolTable;
}): SymbolId => {
  const imported = importedTargetForSymbol({
    symbol: operationSymbol,
    symbolTable,
  });
  if (!imported) {
    return operationSymbol;
  }

  return (
    Array.from(symbolTable.symbolsInScope(symbolTable.rootScope)).find(
      (candidate) => {
        const record = symbolTable.getSymbol(candidate);
        if (record.kind !== "effect-op") {
          return false;
        }
        const target = importedTargetForSymbol({
          symbol: candidate,
          symbolTable,
        });
        return (
          target?.moduleId === imported.moduleId &&
          target.symbol === imported.symbol
        );
      },
    ) ?? operationSymbol
  );
};

const importedTargetForSymbol = ({
  symbol,
  symbolTable,
}: {
  symbol: SymbolId;
  symbolTable: SymbolTable;
}): { moduleId: string; symbol: SymbolId } | undefined => {
  const metadata = symbolTable.getSymbol(symbol).metadata as
    | { import?: { moduleId?: unknown; symbol?: unknown } }
    | undefined;
  const moduleId = metadata?.import?.moduleId;
  const targetSymbol = metadata?.import?.symbol;
  return typeof moduleId === "string" && typeof targetSymbol === "number"
    ? { moduleId, symbol: targetSymbol }
    : undefined;
};

export const resolveQualifiedEffectOperation = ({
  effectSymbol,
  name,
  symbolTable,
  moduleMembers,
  bindingIdentity,
  directSymbol,
}: {
  effectSymbol: SymbolId;
  name: string;
  symbolTable: SymbolTable;
  moduleMembers: EffectOperationMemberTable;
  bindingIdentity?: string;
  directSymbol?: SymbolId;
}): SymbolId | undefined => {
  if (symbolTable.getSymbol(effectSymbol).kind !== "effect") {
    return undefined;
  }
  const candidates = moduleMembers.get(effectSymbol)?.get(name);
  if (!candidates) {
    return undefined;
  }
  const operations = Array.from(candidates).filter(
    (candidate) => symbolTable.getSymbol(candidate).kind === "effect-op",
  );
  if (directSymbol !== undefined && operations.includes(directSymbol)) {
    return directSymbol;
  }
  if (bindingIdentity) {
    const hygienic = operations.findLast(
      (candidate) =>
        symbolTable.getSymbol(candidate).bindingIdentity === bindingIdentity,
    );
    if (hygienic !== undefined) {
      return hygienic;
    }
  }
  return operations.length === 1 ? operations[0] : undefined;
};

export const resolveUnqualifiedEffectOperation = ({
  name,
  scope,
  symbolTable,
  bindingIdentity,
  directSymbol,
}: {
  name: string;
  scope: ScopeId;
  symbolTable: SymbolTable;
  bindingIdentity?: string;
  directSymbol?: SymbolId;
}): SymbolId | undefined => {
  if (
    directSymbol !== undefined &&
    symbolTable.getSymbol(directSymbol).kind === "effect-op"
  ) {
    return directSymbol;
  }
  if (bindingIdentity) {
    const hygienic = symbolTable
      .resolveAllBindings(name, bindingIdentity, scope)
      .findLast(
        (candidate) => symbolTable.getSymbol(candidate).kind === "effect-op",
      );
    if (hygienic !== undefined) {
      return hygienic;
    }
  }
  const candidates = symbolTable.resolveAllByKinds(name, scope, ["effect-op"]);
  const exposedCandidates = candidates.filter((symbol) => {
    const metadata = (symbolTable.getSymbol(symbol).metadata ?? {}) as {
      import?: unknown;
      qualifiedOnlyEffectOperation?: unknown;
      unqualifiedEffectOperationNames?: readonly string[];
    };
    return (
      (metadata.import !== undefined &&
        metadata.qualifiedOnlyEffectOperation !== true) ||
      metadata.unqualifiedEffectOperationNames?.includes(name) === true
    );
  });
  const local = exposedCandidates.findLast((symbol) => {
    const metadata = symbolTable.getSymbol(symbol).metadata as
      | { import?: unknown }
      | undefined;
    return metadata?.import === undefined;
  });
  return local ?? exposedCandidates[0];
};
