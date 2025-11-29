import type { ScopeId, SymbolId } from "../ids.js";
import type {
  ScopeInfo,
  SymbolRecord,
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

export class SymbolTable {
  private nextScope: ScopeId = 0;
  private nextSymbol: SymbolId = 0;
  private readonly scopeBuckets: ScopeBucket[] = [];
  private readonly symbolRecords: SymbolRecord[] = [];
  private readonly scopeStack: ScopeId[] = [];
  readonly rootScope: ScopeId;

  constructor(init: SymbolTableInit) {
    this.rootScope = this.createBucket({
      parent: null,
      kind: init.rootKind ?? "module",
      owner: init.rootOwner,
    });
    this.scopeStack.push(this.rootScope);
  }

  private createBucket(info: Omit<ScopeInfo, "id">): ScopeId {
    if (typeof info.parent === "number" && !this.scopeBuckets[info.parent]) {
      throw new Error(
        `cannot create scope without registering parent ${info.parent}`
      );
    }

    const id = this.nextScope++;
    const bucket: ScopeBucket = {
      info: { ...info, id },
      locals: [],
      nameIndex: new Map(),
    };
    this.scopeBuckets[id] = bucket;
    return id;
  }

  private currentScope(): ScopeId {
    const scope = this.scopeStack.at(-1);
    if (scope === undefined) {
      throw new Error("symbol table scope stack underflow");
    }

    return scope;
  }

  createScope(info: Omit<ScopeInfo, "id">): ScopeId {
    return this.createBucket(info);
  }

  enterScope(scope: ScopeId): void {
    ensureScopeExists(this.scopeBuckets[scope], scope);
    this.scopeStack.push(scope);
  }

  exitScope(): void {
    if (this.scopeStack.length <= 1) {
      throw new Error("attempted to exit root scope");
    }

    this.scopeStack.pop();
  }

  declare(
    symbol: Omit<SymbolRecord, "id" | "scope">,
    scope: ScopeId = this.currentScope()
  ): SymbolId {
    const id = this.nextSymbol++;
    const record: SymbolRecord = { ...symbol, id, scope };
    this.symbolRecords[id] = record;

    const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
    bucket.locals.push(id);

    const hits = bucket.nameIndex.get(record.name);
    if (hits) {
      hits.push(id);
    } else {
      bucket.nameIndex.set(record.name, [id]);
    }

    return id;
  }

  getScope(id: ScopeId): Readonly<ScopeInfo> {
    return cloneScopeInfo(
      ensureScopeExists(this.scopeBuckets[id], id).info
    );
  }

  getSymbol(id: SymbolId): Readonly<SymbolRecord> {
    const record = this.symbolRecords[id];
    if (!record) {
      throw new Error(`symbol ${id} does not exist`);
    }

    return cloneSymbolRecord(record);
  }

  resolve(name: string, fromScope: ScopeId): SymbolId | undefined {
    let scope: ScopeId | null = fromScope;
    while (scope !== null) {
      const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
      const hits = bucket.nameIndex.get(name);
      if (hits && hits.length > 0) {
        return hits[0];
      }

      scope = bucket.info.parent;
    }

    return undefined;
  }

  resolveAll(name: string, fromScope: ScopeId): readonly SymbolId[] {
    const resolved: SymbolId[] = [];
    let scope: ScopeId | null = fromScope;

    while (scope !== null) {
      const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
      const hits = bucket.nameIndex.get(name);
      if (hits && hits.length > 0) {
        resolved.push(...hits);
      }

      scope = bucket.info.parent;
    }

    return resolved;
  }

  setSymbolMetadata(
    id: SymbolId,
    metadata: Record<string, unknown>
  ): void {
    const record = this.symbolRecords[id];
    if (!record) {
      throw new Error(`symbol ${id} does not exist`);
    }
    record.metadata = { ...(record.metadata ?? {}), ...metadata };
  }

  *symbolsInScope(scope: ScopeId): IterableIterator<SymbolId> {
    const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
    yield* bucket.locals;
  }

  snapshot(payload?: Record<string, unknown>): SymbolTableSnapshot {
    return {
      nextScope: this.nextScope,
      nextSymbol: this.nextSymbol,
      scopes: this.scopeBuckets.map((bucket) => cloneScopeInfo(bucket.info)),
      symbols: this.symbolRecords.map(cloneSymbolRecord),
      payload,
    };
  }

  restore(snap: SymbolTableSnapshot): void {
    this.nextScope = snap.nextScope;
    this.nextSymbol = snap.nextSymbol;

    this.scopeBuckets.length = 0;
    snap.scopes.forEach((info) => {
      this.scopeBuckets[info.id] = {
        info: { ...info },
        locals: [],
        nameIndex: new Map(),
      };
    });

    this.symbolRecords.length = 0;
    snap.symbols.forEach((symbol) => {
      const record = cloneSymbolRecord(symbol);
      this.symbolRecords[record.id] = record;

      const bucket = ensureScopeExists(
        this.scopeBuckets[record.scope],
        record.scope
      );
      bucket.locals.push(record.id);
      const hits = bucket.nameIndex.get(record.name);
      if (hits) {
        hits.push(record.id);
      } else {
        bucket.nameIndex.set(record.name, [record.id]);
      }
    });

    this.scopeStack.length = 0;
    this.scopeStack.push(this.rootScope);
  }
}
