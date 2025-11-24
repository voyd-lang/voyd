import type {
  HirExprId,
  SymbolId,
  TypeId,
  TypeSchemeId,
} from "../ids.js";

export interface TypeTable {
  setExprType(id: HirExprId, type: TypeId): void;
  getExprType(id: HirExprId): TypeId | undefined;
  clearExprTypes(): void;
  pushExprTypeScope(): void;
  popExprTypeScope(): void;
  setSymbolScheme(symbol: SymbolId, scheme: TypeSchemeId): void;
  getSymbolScheme(symbol: SymbolId): TypeSchemeId | undefined;
  entries(): Iterable<[HirExprId, TypeId]>;
}

export const createTypeTable = (): TypeTable => {
  const exprTypeStack = [new Map<HirExprId, TypeId>()];
  const symbolSchemes = new Map<SymbolId, TypeSchemeId>();

  const currentExprTypes = (): Map<HirExprId, TypeId> =>
    exprTypeStack[exprTypeStack.length - 1]!;

  const setExprType = (id: HirExprId, type: TypeId): void => {
    currentExprTypes().set(id, type);
  };

  const getExprType = (id: HirExprId): TypeId | undefined =>
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
    currentExprTypes().entries();

  return {
    setExprType,
    getExprType,
    clearExprTypes,
    pushExprTypeScope,
    popExprTypeScope,
    setSymbolScheme,
    getSymbolScheme,
    entries,
  };
};
