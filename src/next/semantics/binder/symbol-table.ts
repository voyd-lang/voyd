import type { ScopeId, SymbolId } from "../ids.js";
import type {
  ScopeInfo,
  SymbolRecord,
  SymbolTable,
  SymbolTableInit,
  SymbolTableSnapshot,
} from "./types.js";

interface ScopeBucket {
  info: ScopeInfo;
  locals: SymbolId[];
  nameIndex: Map<string, SymbolId[]>;
}

const cloneScopeInfo = (info: ScopeInfo): ScopeInfo => ({ ...info });

const cloneSymbolRecord = (symbol: SymbolRecord): SymbolRecord => ({
  ...symbol,
  metadata: symbol.metadata ? { ...symbol.metadata } : undefined,
});

const ensureScopeExists = (
  bucket: ScopeBucket | undefined,
  scope: ScopeId
): ScopeBucket => {
  if (!bucket) {
    throw new Error(`symbol table scope ${scope} does not exist`);
  }

  return bucket;
};

export const createSymbolTable = (init: SymbolTableInit): SymbolTable => {
  let nextScope: ScopeId = 0;
  let nextSymbol: SymbolId = 0;

  const scopeBuckets: ScopeBucket[] = [];
  const symbolRecords: SymbolRecord[] = [];
  const scopeStack: ScopeId[] = [];

  const createBucket = (info: Omit<ScopeInfo, "id">): ScopeId => {
    if (typeof info.parent === "number" && !scopeBuckets[info.parent]) {
      throw new Error(
        `cannot create scope without registering parent ${info.parent}`
      );
    }

    const id = nextScope++;
    const bucket: ScopeBucket = {
      info: { ...info, id },
      locals: [],
      nameIndex: new Map(),
    };
    scopeBuckets[id] = bucket;
    return id;
  };

  const rootScope = createBucket({
    parent: null,
    kind: init.rootKind ?? "module",
    owner: init.rootOwner,
  });
  scopeStack.push(rootScope);

  const currentScope = (): ScopeId => {
    const scope = scopeStack.at(-1);
    if (scope === undefined) {
      throw new Error("symbol table scope stack underflow");
    }

    return scope;
  };

  const enterScope = (scope: ScopeId): void => {
    ensureScopeExists(scopeBuckets[scope], scope);
    scopeStack.push(scope);
  };

  const exitScope = (): void => {
    if (scopeStack.length <= 1) {
      throw new Error("attempted to exit root scope");
    }

    scopeStack.pop();
  };

  const createScope = (info: Omit<ScopeInfo, "id">): ScopeId =>
    createBucket(info);

  const declare = (symbol: Omit<SymbolRecord, "id" | "scope">): SymbolId => {
    const scope = currentScope();
    const id = nextSymbol++;
    const record: SymbolRecord = { ...symbol, id, scope };
    symbolRecords[id] = record;

    const bucket = ensureScopeExists(scopeBuckets[scope], scope);
    bucket.locals.push(id);
    const hits = bucket.nameIndex.get(record.name);
    if (hits) {
      hits.push(id);
    } else {
      bucket.nameIndex.set(record.name, [id]);
    }

    return id;
  };

  const getScope = (id: ScopeId): Readonly<ScopeInfo> =>
    cloneScopeInfo(ensureScopeExists(scopeBuckets[id], id).info);

  const getSymbol = (id: SymbolId): Readonly<SymbolRecord> => {
    const record = symbolRecords[id];
    if (!record) {
      throw new Error(`symbol ${id} does not exist`);
    }

    return cloneSymbolRecord(record);
  };

  const resolve = (name: string, fromScope: ScopeId): SymbolId | undefined => {
    let scope: ScopeId | null = fromScope;
    while (scope !== null) {
      const bucket = ensureScopeExists(scopeBuckets[scope], scope);
      const hits = bucket.nameIndex.get(name);
      if (hits && hits.length > 0) {
        return hits[0];
      }

      scope = bucket.info.parent;
    }

    return undefined;
  };

  const resolveAll = (
    name: string,
    fromScope: ScopeId
  ): readonly SymbolId[] => {
    const resolved: SymbolId[] = [];
    let scope: ScopeId | null = fromScope;

    while (scope !== null) {
      const bucket = ensureScopeExists(scopeBuckets[scope], scope);
      const hits = bucket.nameIndex.get(name);
      if (hits && hits.length > 0) {
        resolved.push(...hits);
      }

      scope = bucket.info.parent;
    }

    return resolved;
  };

  const symbolsInScope = function* (
    scope: ScopeId
  ): IterableIterator<SymbolId> {
    const bucket = ensureScopeExists(scopeBuckets[scope], scope);
    yield* bucket.locals;
  };

  const snapshot = (
    payload?: Record<string, unknown>
  ): SymbolTableSnapshot => ({
    nextScope,
    nextSymbol,
    scopes: scopeBuckets.map((bucket) => cloneScopeInfo(bucket.info)),
    symbols: symbolRecords.map(cloneSymbolRecord),
    payload,
  });

  const restore = (snap: SymbolTableSnapshot): void => {
    nextScope = snap.nextScope;
    nextSymbol = snap.nextSymbol;

    scopeBuckets.length = 0;
    snap.scopes.forEach((info) => {
      scopeBuckets[info.id] = {
        info: { ...info },
        locals: [],
        nameIndex: new Map(),
      };
    });

    symbolRecords.length = 0;
    snap.symbols.forEach((symbol) => {
      const record = cloneSymbolRecord(symbol);
      symbolRecords[record.id] = record;

      const bucket = ensureScopeExists(scopeBuckets[record.scope], record.scope);
      bucket.locals.push(record.id);
      const hits = bucket.nameIndex.get(record.name);
      if (hits) {
        hits.push(record.id);
      } else {
        bucket.nameIndex.set(record.name, [record.id]);
      }
    });

    scopeStack.length = 0;
    scopeStack.push(rootScope);
  };

  return {
    rootScope,
    createScope,
    enterScope,
    exitScope,
    declare,
    resolve,
    resolveAll,
    getSymbol,
    getScope,
    symbolsInScope,
    snapshot,
    restore,
  };
};
