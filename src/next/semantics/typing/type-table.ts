import type {
  HirExprId,
  SymbolId,
  TypeId,
  TypeSchemeId,
} from "../ids.js";

export interface TypeTable {
  setExprType(id: HirExprId, type: TypeId): void;
  getExprType(id: HirExprId): TypeId | undefined;
  setSymbolScheme(symbol: SymbolId, scheme: TypeSchemeId): void;
  getSymbolScheme(symbol: SymbolId): TypeSchemeId | undefined;
  entries(): Iterable<[HirExprId, TypeId]>;
}

export const createTypeTable = (): TypeTable => {
  const exprTypes = new Map<HirExprId, TypeId>();
  const symbolSchemes = new Map<SymbolId, TypeSchemeId>();

  const setExprType = (id: HirExprId, type: TypeId): void => {
    exprTypes.set(id, type);
  };

  const getExprType = (id: HirExprId): TypeId | undefined =>
    exprTypes.get(id);

  const setSymbolScheme = (symbol: SymbolId, scheme: TypeSchemeId): void => {
    symbolSchemes.set(symbol, scheme);
  };

  const getSymbolScheme = (
    symbol: SymbolId
  ): TypeSchemeId | undefined => symbolSchemes.get(symbol);

  const entries = (): Iterable<[HirExprId, TypeId]> => exprTypes.entries();

  return {
    setExprType,
    getExprType,
    setSymbolScheme,
    getSymbolScheme,
    entries,
  };
};
