import type {
  HirExprId,
  SymbolId,
  TypeId,
  TypeSchemeId,
} from "../ids.js";

export interface ExprTypeEntry {
  type: TypeId;
  weak: boolean;
}

export interface TypeTable {
  setExprType(
    id: HirExprId,
    type: TypeId,
    options?: { weak?: boolean }
  ): void;
  getExprType(id: HirExprId): TypeId | undefined;
  getExprTypeEntry(id: HirExprId): ExprTypeEntry | undefined;
  clearExprTypes(): void;
  pushExprTypeScope(): void;
  popExprTypeScope(): void;
  setSymbolScheme(symbol: SymbolId, scheme: TypeSchemeId): void;
  getSymbolScheme(symbol: SymbolId): TypeSchemeId | undefined;
  entries(): Iterable<[HirExprId, TypeId]>;
}

export const createTypeTable = (): TypeTable => {
  const exprTypeStack = [new Map<HirExprId, ExprTypeEntry>()];
  const symbolSchemes = new Map<SymbolId, TypeSchemeId>();

  const currentExprTypes = (): Map<HirExprId, ExprTypeEntry> =>
    exprTypeStack[exprTypeStack.length - 1]!;

  const setExprType = (
    id: HirExprId,
    type: TypeId,
    options?: { weak?: boolean }
  ): void => {
    currentExprTypes().set(id, { type, weak: options?.weak === true });
  };

  const getExprType = (id: HirExprId): TypeId | undefined =>
    currentExprTypes().get(id)?.type;

  const getExprTypeEntry = (id: HirExprId): ExprTypeEntry | undefined =>
    currentExprTypes().get(id);

  const clearExprTypes = (): void => {
    currentExprTypes().clear();
  };

  const pushExprTypeScope = (): void => {
    exprTypeStack.push(new Map());
  };

  const popExprTypeScope = (): void => {
    if (exprTypeStack.length === 1) {
      throw new Error("cannot pop root expression type scope");
    }
    exprTypeStack.pop();
  };

  const setSymbolScheme = (symbol: SymbolId, scheme: TypeSchemeId): void => {
    symbolSchemes.set(symbol, scheme);
  };

  const getSymbolScheme = (
    symbol: SymbolId
  ): TypeSchemeId | undefined => symbolSchemes.get(symbol);

  const entries = (): Iterable<[HirExprId, TypeId]> =>
    Array.from(currentExprTypes().entries(), ([id, entry]) => [id, entry.type]);

  return {
    setExprType,
    getExprType,
    getExprTypeEntry,
    clearExprTypes,
    pushExprTypeScope,
    popExprTypeScope,
    setSymbolScheme,
    getSymbolScheme,
    entries,
  };
};
