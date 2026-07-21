import type { SymbolTable } from "./binder/index.js";
import type { ScopeId, SymbolId } from "./ids.js";

export const resolveUnqualifiedEffectOperation = ({
  name,
  scope,
  symbolTable,
}: {
  name: string;
  scope: ScopeId;
  symbolTable: SymbolTable;
}): SymbolId | undefined => {
  const candidates = symbolTable
    .resolveAllByKinds(name, scope, ["effect-op"])
    .filter((symbol) => {
      const metadata = (symbolTable.getSymbol(symbol).metadata ?? {}) as {
        import?: unknown;
        unqualifiedEffectOperationNames?: readonly string[];
      };
      return (
        metadata.import !== undefined ||
        metadata.unqualifiedEffectOperationNames === undefined ||
        metadata.unqualifiedEffectOperationNames?.includes(name) === true
      );
    });
  const local = candidates.findLast((symbol) => {
    const metadata = symbolTable.getSymbol(symbol).metadata as
      | { import?: unknown }
      | undefined;
    return metadata?.import === undefined;
  });
  return local ?? candidates[0];
};
