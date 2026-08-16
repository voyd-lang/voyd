import type { ScopeId, SymbolId } from "../ids.js";
import type {
  ScopeInfo,
  SymbolAliasBinding,
  SymbolKind,
  SymbolRecord,
  SymbolTableInit,
  SymbolTableSnapshot,
} from "./types.js";

interface ScopeBucket {
  info: ScopeInfo;
  locals: SymbolId[];
  nameIndex: Map<string, SymbolId[]>;
  bindingIndex: Map<string, SymbolId[]>;
  surfaceAliases: Map<string, Set<SymbolId>>;
}

const bindingIndexKey = (name: string, identity: string): string =>
  `${name}\u0000${identity}`;

const RESERVED_SYMBOL_NAMES = new Set(["void"]);
const RESERVED_TYPE_NAMES = new Set(["Borrow"]);

const symbolUsesTypeNamespace = (kind: SymbolKind): boolean =>
  kind === "type" ||
  kind === "type-parameter" ||
  kind === "trait" ||
  kind === "effect";

const cloneScopeInfo = (info: ScopeInfo): ScopeInfo => ({ ...info });

const copySymbolRecord = (symbol: SymbolRecord): SymbolRecord => ({ ...symbol });

const cloneSymbolRecordForOwnershipBoundary = (
  symbol: SymbolRecord,
): SymbolRecord => ({
  ...symbol,
  metadata: symbol.metadata
    ? cloneSymbolMetadataValue(symbol.metadata)
    : undefined,
});

const cloneSymbolMetadataValue = <T>(value: T): T => {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneSymbolMetadataValue) as T;
  }
  if (value instanceof Map) {
    return new Map(
      Array.from(value, ([key, entry]) => [
        key,
        cloneSymbolMetadataValue(entry),
      ]),
    ) as T;
  }
  if (value instanceof Set) {
    return new Set(Array.from(value, cloneSymbolMetadataValue)) as T;
  }
  if (value instanceof Uint8Array) {
    return value.slice() as T;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      cloneSymbolMetadataValue(entry),
    ]),
  ) as T;
};

const ensureScopeExists = (
  bucket: ScopeBucket | undefined,
  scope: ScopeId,
): ScopeBucket => {
  if (!bucket) {
    throw new Error(`symbol table scope ${scope} does not exist`);
  }

  return bucket;
};

type SymbolPredicate = (record: Readonly<SymbolRecord>) => boolean;

const isImportedSymbolRecord = (record: SymbolRecord): boolean => {
  const metadata = record.metadata as { import?: unknown } | undefined;
  return metadata?.import !== undefined;
};

export class SymbolTable {
  private nextScope: ScopeId = 0;
  private nextSymbol: SymbolId = 0;
  private readonly scopeBuckets: ScopeBucket[] = [];
  private readonly symbolRecords: SymbolRecord[] = [];
  private readonly scopeStack: ScopeId[] = [];
  private readonly aliasBindings: SymbolAliasBinding[] = [];
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
        `cannot create scope without registering parent ${info.parent}`,
      );
    }

    const id = this.nextScope++;
    const bucket: ScopeBucket = {
      info: { ...info, id },
      locals: [],
      nameIndex: new Map(),
      bindingIndex: new Map(),
      surfaceAliases: new Map(),
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
    scope: ScopeId = this.currentScope(),
  ): SymbolId {
    if (
      RESERVED_SYMBOL_NAMES.has(symbol.name) ||
      (RESERVED_TYPE_NAMES.has(symbol.name) &&
        symbolUsesTypeNamespace(symbol.kind))
    ) {
      throw new Error(`cannot declare reserved identifier ${symbol.name}`);
    }
    const id = this.nextSymbol++;
    const record: SymbolRecord = {
      ...symbol,
      id,
      scope,
      metadata: symbol.metadata
        ? cloneSymbolMetadataValue(symbol.metadata)
        : undefined,
    };
    this.symbolRecords[id] = record;

    const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
    bucket.locals.push(id);

    const hits = bucket.nameIndex.get(record.name);
    if (hits) {
      hits.push(id);
    } else {
      bucket.nameIndex.set(record.name, [id]);
    }
    if (record.bindingIdentity) {
      const key = bindingIndexKey(record.name, record.bindingIdentity);
      const bindingHits = bucket.bindingIndex.get(key);
      if (bindingHits) {
        bindingHits.push(id);
      } else {
        bucket.bindingIndex.set(key, [id]);
      }
    }

    return id;
  }

  bindAlias(
    {
      name,
      symbol,
      bindingIdentity,
    }: Pick<SymbolAliasBinding, "name" | "symbol" | "bindingIdentity">,
    scope: ScopeId = this.currentScope(),
  ): void {
    const aliasedSymbol = this.symbolRecords[symbol];
    if (
      RESERVED_SYMBOL_NAMES.has(name) ||
      (RESERVED_TYPE_NAMES.has(name) &&
        aliasedSymbol &&
        symbolUsesTypeNamespace(aliasedSymbol.kind))
    ) {
      throw new Error(`cannot declare reserved identifier ${name}`);
    }
    if (!this.symbolRecords[symbol]) {
      throw new Error(`symbol ${symbol} does not exist`);
    }
    const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
    if (bindingIdentity) {
      const key = bindingIndexKey(name, bindingIdentity);
      const hits = bucket.bindingIndex.get(key);
      if (hits) {
        hits.push(symbol);
      } else {
        bucket.bindingIndex.set(key, [symbol]);
      }
    } else {
      const hits = bucket.nameIndex.get(name);
      if (hits) {
        if (!hits.includes(symbol)) {
          hits.push(symbol);
        }
      } else {
        bucket.nameIndex.set(name, [symbol]);
      }
      const aliases = bucket.surfaceAliases.get(name) ?? new Set<SymbolId>();
      aliases.add(symbol);
      bucket.surfaceAliases.set(name, aliases);
    }
    this.aliasBindings.push({ name, symbol, scope, bindingIdentity });
  }

  getScope(id: ScopeId): Readonly<ScopeInfo> {
    return cloneScopeInfo(ensureScopeExists(this.scopeBuckets[id], id).info);
  }

  getSymbol(id: SymbolId): Readonly<SymbolRecord> {
    const record = this.symbolRecords[id];
    if (!record) {
      throw new Error(`symbol ${id} does not exist`);
    }

    return copySymbolRecord(record);
  }

  hasSymbol(id: SymbolId): boolean {
    return this.symbolRecords[id] !== undefined;
  }

  resolve(name: string, fromScope: ScopeId): SymbolId | undefined {
    return this.resolveInternal(
      name,
      fromScope,
      (record) => record.bindingIdentity === undefined,
    );
  }

  resolveAll(name: string, fromScope: ScopeId): readonly SymbolId[] {
    return this.resolveAllInternal(
      name,
      fromScope,
      (record) => record.bindingIdentity === undefined,
    );
  }

  resolveBinding(
    name: string,
    bindingIdentity: string,
    fromScope: ScopeId,
  ): SymbolId | undefined {
    return this.resolveBindingInternal(name, bindingIdentity, fromScope)[0];
  }

  resolveAllBindings(
    name: string,
    bindingIdentity: string,
    fromScope: ScopeId,
  ): readonly SymbolId[] {
    return this.resolveBindingInternal(name, bindingIdentity, fromScope);
  }

  symbolsNamedInScope(name: string, scope: ScopeId): readonly SymbolId[] {
    const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
    return [...(bucket.nameIndex.get(name) ?? [])];
  }

  resolveWhere(
    name: string,
    fromScope: ScopeId,
    predicate: SymbolPredicate,
  ): SymbolId | undefined {
    return this.resolveInternal(
      name,
      fromScope,
      (record) => record.bindingIdentity === undefined && predicate(record),
    );
  }

  resolveAllWhere(
    name: string,
    fromScope: ScopeId,
    predicate: SymbolPredicate,
  ): readonly SymbolId[] {
    return this.resolveAllInternal(
      name,
      fromScope,
      (record) => record.bindingIdentity === undefined && predicate(record),
    );
  }

  resolveByKinds(
    name: string,
    fromScope: ScopeId,
    kinds: readonly SymbolKind[],
  ): SymbolId | undefined {
    const allowedKinds = new Set(kinds);
    return this.resolveInternal(
      name,
      fromScope,
      (record) =>
        record.bindingIdentity === undefined && allowedKinds.has(record.kind),
    );
  }

  resolveAllByKinds(
    name: string,
    fromScope: ScopeId,
    kinds: readonly SymbolKind[],
  ): readonly SymbolId[] {
    const allowedKinds = new Set(kinds);
    return this.resolveAllInternal(
      name,
      fromScope,
      (record) =>
        record.bindingIdentity === undefined && allowedKinds.has(record.kind),
    );
  }

  private resolveInternal(
    name: string,
    fromScope: ScopeId,
    predicate?: SymbolPredicate,
  ): SymbolId | undefined {
    let scope: ScopeId | null = fromScope;
    let importedFallback: SymbolId | undefined;
    while (scope !== null) {
      const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
      const hits = bucket.nameIndex.get(name);
      if (hits && hits.length > 0) {
        for (let index = hits.length - 1; index >= 0; index -= 1) {
          const candidate = hits[index]!;
          const record = this.symbolRecords[candidate];
          if (!record || isImportedSymbolRecord(record)) {
            continue;
          }
          const resolvedRecord = bucket.surfaceAliases.get(name)?.has(candidate)
            ? { ...record, bindingIdentity: undefined }
            : record;
          if (!predicate || predicate(resolvedRecord)) {
            return candidate;
          }
        }

        if (typeof importedFallback !== "number") {
          for (const candidate of hits) {
            const record = this.symbolRecords[candidate];
            if (!record) {
              continue;
            }
            const resolvedRecord = bucket.surfaceAliases
              .get(name)
              ?.has(candidate)
              ? { ...record, bindingIdentity: undefined }
              : record;
            if (!predicate || predicate(resolvedRecord)) {
              importedFallback = candidate;
              break;
            }
          }
        }
      }

      scope = bucket.info.parent;
    }

    return importedFallback;
  }

  private resolveBindingInternal(
    name: string,
    bindingIdentity: string,
    fromScope: ScopeId,
  ): readonly SymbolId[] {
    const resolved: SymbolId[] = [];
    let scope: ScopeId | null = fromScope;
    while (scope !== null) {
      const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
      const hits = bucket.bindingIndex.get(
        bindingIndexKey(name, bindingIdentity),
      );
      if (hits?.length) {
        const local = hits.filter(
          (candidate) =>
            !isImportedSymbolRecord(this.symbolRecords[candidate]!),
        );
        if (local.length > 0) {
          return [...local].reverse();
        }
        resolved.push(...hits);
      }
      scope = bucket.info.parent;
    }
    return resolved;
  }

  private resolveAllInternal(
    name: string,
    fromScope: ScopeId,
    predicate?: SymbolPredicate,
  ): readonly SymbolId[] {
    const resolved: SymbolId[] = [];
    let scope: ScopeId | null = fromScope;

    while (scope !== null) {
      const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
      const hits = bucket.nameIndex.get(name);
      if (hits && hits.length > 0) {
        if (!predicate) {
          resolved.push(...hits);
        } else {
          for (const candidate of hits) {
            const record = this.symbolRecords[candidate];
            if (!record) {
              continue;
            }
            const resolvedRecord = bucket.surfaceAliases
              .get(name)
              ?.has(candidate)
              ? { ...record, bindingIdentity: undefined }
              : record;
            if (predicate(resolvedRecord)) {
              resolved.push(candidate);
            }
          }
        }
      }

      scope = bucket.info.parent;
    }

    return resolved;
  }

  setSymbolMetadata(id: SymbolId, metadata: Record<string, unknown>): void {
    const record = this.symbolRecords[id];
    if (!record) {
      throw new Error(`symbol ${id} does not exist`);
    }
    record.metadata = cloneSymbolMetadataValue({
      ...(record.metadata ?? {}),
      ...metadata,
    });
  }

  *symbolsInScope(scope: ScopeId): IterableIterator<SymbolId> {
    const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
    yield* bucket.locals;
  }

  surfaceNamesForSymbol(symbol: SymbolId, scope: ScopeId): readonly string[] {
    const record = this.symbolRecords[symbol];
    if (!record) {
      throw new Error(`symbol ${symbol} does not exist`);
    }
    const bucket = ensureScopeExists(this.scopeBuckets[scope], scope);
    const names = new Set<string>();

    if (record.scope === scope && record.bindingIdentity === undefined) {
      names.add(record.name);
    }
    bucket.surfaceAliases.forEach((symbols, name) => {
      if (symbols.has(symbol)) {
        names.add(name);
      }
    });

    return Array.from(names);
  }

  snapshot(payload?: Record<string, unknown>): SymbolTableSnapshot {
    return {
      nextScope: this.nextScope,
      nextSymbol: this.nextSymbol,
      scopes: this.scopeBuckets.map((bucket) => cloneScopeInfo(bucket.info)),
      symbols: this.symbolRecords.map(cloneSymbolRecordForOwnershipBoundary),
      ...(this.aliasBindings.length > 0
        ? { aliases: this.aliasBindings.map((alias) => ({ ...alias })) }
        : {}),
      payload: payload ? cloneSymbolMetadataValue(payload) : undefined,
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
        bindingIndex: new Map(),
        surfaceAliases: new Map(),
      };
    });

    this.symbolRecords.length = 0;
    snap.symbols.forEach((symbol) => {
      const record = cloneSymbolRecordForOwnershipBoundary(symbol);
      this.symbolRecords[record.id] = record;

      const bucket = ensureScopeExists(
        this.scopeBuckets[record.scope],
        record.scope,
      );
      bucket.locals.push(record.id);
      const hits = bucket.nameIndex.get(record.name);
      if (hits) {
        hits.push(record.id);
      } else {
        bucket.nameIndex.set(record.name, [record.id]);
      }
      if (record.bindingIdentity) {
        const key = bindingIndexKey(record.name, record.bindingIdentity);
        const bindingHits = bucket.bindingIndex.get(key);
        if (bindingHits) {
          bindingHits.push(record.id);
        } else {
          bucket.bindingIndex.set(key, [record.id]);
        }
      }
    });

    this.aliasBindings.length = 0;
    (snap.aliases ?? []).forEach((alias) => {
      const bucket = ensureScopeExists(
        this.scopeBuckets[alias.scope],
        alias.scope,
      );
      if (alias.bindingIdentity) {
        const key = bindingIndexKey(alias.name, alias.bindingIdentity);
        const hits = bucket.bindingIndex.get(key);
        if (hits) {
          hits.push(alias.symbol);
        } else {
          bucket.bindingIndex.set(key, [alias.symbol]);
        }
      } else {
        const hits = bucket.nameIndex.get(alias.name);
        if (hits) {
          if (!hits.includes(alias.symbol)) {
            hits.push(alias.symbol);
          }
        } else {
          bucket.nameIndex.set(alias.name, [alias.symbol]);
        }
        const aliases =
          bucket.surfaceAliases.get(alias.name) ?? new Set<SymbolId>();
        aliases.add(alias.symbol);
        bucket.surfaceAliases.set(alias.name, aliases);
      }
      this.aliasBindings.push({ ...alias });
    });

    this.scopeStack.length = 0;
    this.scopeStack.push(this.rootScope);
  }
}
