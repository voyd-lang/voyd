import type {
  EffectRowId,
  HirExprId,
  NodeId,
  SymbolId,
  TypeSchemeId,
} from "../ids.js";

export type RegionId = number;

export interface EffectOp {
  name: string;
  region?: RegionId;
}

export interface EffectRowVariable {
  id: number;
  rigid: boolean;
}

export interface EffectRowDesc {
  operations: readonly EffectOp[];
  tailVar?: EffectRowVariable;
}

export interface UnificationContext {
  location: NodeId;
  reason: string;
}

export type EffectSubstitution = {
  rows: ReadonlyMap<number, EffectRowId>;
};

export interface EffectConflict {
  left: EffectRowId;
  right: EffectRowId;
  message: string;
}

export type UnificationResult =
  | { ok: true; substitution: EffectSubstitution }
  | { ok: false; conflict: EffectConflict };

export interface EffectTable {
  emptyRow: EffectRowId;
  unknownRow: EffectRowId;
  internRow(desc: EffectRowDesc): EffectRowId;
  getRow(id: EffectRowId): Readonly<EffectRowDesc>;
  compose(a: EffectRowId, b: EffectRowId): EffectRowId;
  constrain(
    sub: EffectRowId,
    sup: EffectRowId,
    ctx: UnificationContext
  ): UnificationResult;
  isEmpty(id: EffectRowId): boolean;
  isOpen(id: EffectRowId): boolean;
  freshTailVar(options?: { rigid?: boolean }): EffectRowVariable;
  setExprEffect(expr: HirExprId, row: EffectRowId): void;
  getExprEffect(expr: HirExprId): EffectRowId | undefined;
  setFunctionEffect(symbol: SymbolId, scheme: TypeSchemeId, row: EffectRowId): void;
  getFunctionEffect(symbol: SymbolId): EffectRowId | undefined;
}

export type EffectInterner = Omit<
  EffectTable,
  "setExprEffect" | "getExprEffect" | "setFunctionEffect" | "getFunctionEffect"
>;

export const createEffectInterner = (): EffectInterner => {
  let nextRowId: EffectRowId = 0;
  let nextTailVarId = 0;
  const rows: EffectRowDesc[] = [];
  const rowCache = new Map<string, EffectRowId>();

  const opKey = (op: EffectOp): string =>
    `${op.name}#${typeof op.region === "number" ? op.region : ""}`;

  const canonicalizeOperations = (
    operations: readonly EffectOp[]
  ): readonly EffectOp[] => {
    const unique = new Map<string, EffectOp>();
    operations.forEach((op) => {
      const canonical: EffectOp = {
        name: op.name,
        region: typeof op.region === "number" ? op.region : undefined,
      };
      const key = opKey(canonical);
      if (!unique.has(key)) {
        unique.set(key, canonical);
      }
    });

    return Object.freeze(
      Array.from(unique.values()).sort((a, b) => {
        const nameOrder = a.name.localeCompare(b.name, undefined, {
          numeric: true,
        });
        if (nameOrder !== 0) {
          return nameOrder;
        }
        const aRegion = typeof a.region === "number" ? a.region : -Infinity;
        const bRegion = typeof b.region === "number" ? b.region : -Infinity;
        return aRegion - bRegion;
      })
    );
  };

  const canonicalizeRow = (desc: EffectRowDesc): EffectRowDesc => ({
    operations: canonicalizeOperations(desc.operations ?? []),
    tailVar: desc.tailVar
      ? Object.freeze({
          id: desc.tailVar.id,
          rigid: desc.tailVar.rigid === true,
        })
      : undefined,
  });

  const rowKey = (desc: EffectRowDesc): string =>
    JSON.stringify(desc, (_, value) => value);

  const getRow = (id: EffectRowId): Readonly<EffectRowDesc> => {
    const row = rows[id];
    if (!row) {
      throw new Error(`unknown EffectRowId ${id}`);
    }
    return row;
  };

  const freshTailVar = (options?: { rigid?: boolean }): EffectRowVariable => ({
    id: nextTailVarId++,
    rigid: options?.rigid ?? false,
  });

  const internRow = (desc: EffectRowDesc): EffectRowId => {
    const normalized = canonicalizeRow(desc);
    const key = rowKey(normalized);
    const cached = rowCache.get(key);
    if (typeof cached === "number") {
      return cached;
    }

    const id = nextRowId++;
    rows[id] = normalized;
    rowCache.set(key, id);
    return id;
  };

  const mergeTailVars = (
    left?: EffectRowVariable,
    right?: EffectRowVariable
  ): EffectRowVariable | undefined => {
    if (left && right) {
      if (left.id === right.id && left.rigid === right.rigid) {
        return left;
      }
      if (!left.rigid) {
        return left;
      }
      if (!right.rigid) {
        return right;
      }
      return freshTailVar({ rigid: true });
    }
    return left ?? right;
  };

  const compose = (a: EffectRowId, b: EffectRowId): EffectRowId => {
    const descA = getRow(a);
    const descB = getRow(b);
    const operations = canonicalizeOperations([
      ...descA.operations,
      ...descB.operations,
    ]);
    const tailVar = mergeTailVars(descA.tailVar, descB.tailVar);
    return internRow({ operations, tailVar });
  };

  const describeOp = (op: EffectOp): string =>
    typeof op.region === "number" ? `${op.name}@${op.region}` : op.name;

  const formatOps = (ops: readonly EffectOp[]): string =>
    ops.map(describeOp).join(", ");

  const constrain = (
    sub: EffectRowId,
    sup: EffectRowId,
    ctx: UnificationContext
  ): UnificationResult => {
    const subRow = getRow(sub);
    const supRow = getRow(sup);

    const supOps = new Set(supRow.operations.map(opKey));
    const missing = subRow.operations.filter((op) => !supOps.has(opKey(op)));

    const supAllowsExtra = Boolean(supRow.tailVar && !supRow.tailVar.rigid);
    const supHasTail = Boolean(supRow.tailVar);
    const substitution = new Map<number, EffectRowId>();

    if (missing.length > 0) {
      if (!supAllowsExtra) {
        return {
          ok: false,
          conflict: {
            left: sub,
            right: sup,
            message: `missing effects (${ctx.reason}): ${formatOps(missing)}`,
          },
        };
      }
      const tailRow = internRow({
        operations: missing,
        tailVar:
          subRow.tailVar && subRow.tailVar.id !== supRow.tailVar?.id
            ? subRow.tailVar
            : undefined,
      });
      substitution.set(supRow.tailVar!.id, tailRow);
    } else if (supAllowsExtra && subRow.tailVar) {
      substitution.set(
        supRow.tailVar!.id,
        internRow({ operations: [], tailVar: subRow.tailVar })
      );
    }

    if (subRow.tailVar && (!supHasTail || supRow.tailVar?.rigid)) {
      if (subRow.tailVar.rigid) {
        return {
          ok: false,
          conflict: {
            left: sub,
            right: sup,
            message: `effect row is too open (${ctx.reason})`,
          },
        };
      }
      substitution.set(subRow.tailVar.id, emptyRow);
    }

    return { ok: true, substitution: { rows: substitution } };
  };

  const isEmpty = (row: EffectRowId): boolean => {
    const desc = getRow(row);
    return desc.operations.length === 0 && !desc.tailVar;
  };

  const isOpen = (row: EffectRowId): boolean => Boolean(getRow(row).tailVar);

  const emptyRow = internRow({ operations: [] });
  const unknownRow = internRow({
    operations: [],
    tailVar: freshTailVar(),
  });

  return {
    emptyRow,
    unknownRow,
    internRow,
    getRow,
    compose,
    constrain,
    isEmpty,
    isOpen,
    freshTailVar,
  };
};

export const createEffectTable = ({
  interner,
}: { interner?: EffectInterner } = {}): EffectTable => {
  const shared = interner ?? createEffectInterner();
  const exprEffects = new Map<HirExprId, EffectRowId>();
  const functionEffects = new Map<
    SymbolId,
    { scheme: TypeSchemeId; row: EffectRowId }
  >();

  const setExprEffect = (expr: HirExprId, row: EffectRowId): void => {
    const existing = exprEffects.get(expr);
    if (typeof existing === "number") {
      if (existing === row) {
        return;
      }
      row = shared.compose(existing, row);
    }
    exprEffects.set(expr, row);
  };

  const getExprEffect = (expr: HirExprId): EffectRowId | undefined =>
    exprEffects.get(expr);

  const setFunctionEffect = (
    symbol: SymbolId,
    scheme: TypeSchemeId,
    row: EffectRowId
  ): void => {
    const existing = functionEffects.get(symbol);
    if (existing && (existing.row !== row || existing.scheme !== scheme)) {
      throw new Error(
        `conflicting effect rows for function ${symbol}: existing=${existing.row}, next=${row}`
      );
    }
    functionEffects.set(symbol, { scheme, row });
  };

  const getFunctionEffect = (symbol: SymbolId): EffectRowId | undefined =>
    functionEffects.get(symbol)?.row;

  return {
    ...shared,
    setExprEffect,
    getExprEffect,
    setFunctionEffect,
    getFunctionEffect,
  };
};
