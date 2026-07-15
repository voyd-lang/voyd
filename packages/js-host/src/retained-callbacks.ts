export type WasmEventHandlerRef<Payload = unknown> = (
  payload: Payload,
) => unknown | Promise<unknown>;

export type RetainedEventHandlerRegistry<Payload = unknown> = {
  retain(handlerRef: WasmEventHandlerRef<Payload>): number;
  dispatch(id: number, payload: Payload): Promise<unknown>;
  release(id: number): void;
  releaseMany(ids: Iterable<number>): void;
  clear(): void;
  size(): number;
};

export type RetainedCallbackScopeManager<Payload = unknown> = {
  beginScope(ownerId: RetainedCallbackScopeOwner): number;
  retain(
    ownerId: RetainedCallbackScopeOwner | undefined,
    handlerRef: WasmEventHandlerRef<Payload>,
  ): number;
  endScope(ownerId: RetainedCallbackScopeOwner, scopeId: number): void;
  finishOwner(ownerId: RetainedCallbackScopeOwner): void;
};

export type RetainedCallbackScopeOwner = number | string | symbol;

export function createRetainedEventHandlerRegistry<Payload = unknown>(): RetainedEventHandlerRegistry<Payload> {
  const handlers = new Map<number, WasmEventHandlerRef<Payload>>();
  let nextId = 1;

  return {
    retain(handlerRef) {
      const id = nextId;
      nextId += 1;
      handlers.set(id, handlerRef);
      return id;
    },
    async dispatch(id, payload) {
      const handler = handlers.get(id);
      if (!handler) return undefined;
      return await handler(payload);
    },
    release(id) {
      handlers.delete(id);
    },
    releaseMany(ids) {
      Array.from(ids).forEach((id) => handlers.delete(id));
    },
    clear() {
      handlers.clear();
    },
    size() {
      return handlers.size;
    },
  };
}

export function createRetainedCallbackScopeManager<Payload = unknown>(
  registry: RetainedEventHandlerRegistry<Payload>,
): RetainedCallbackScopeManager<Payload> {
  type Scope = {
    id: number;
    retainedIds: Set<number>;
  };

  const scopesByOwner = new Map<RetainedCallbackScopeOwner, Scope[]>();
  let nextScopeId = 1;

  const releaseScopes = (scopes: readonly Scope[]): void => {
    const retainedIds = scopes.flatMap((scope) => Array.from(scope.retainedIds));
    if (retainedIds.length > 0) {
      registry.releaseMany(retainedIds);
    }
  };

  return {
    beginScope(ownerId) {
      const scope = {
        id: nextScopeId++,
        retainedIds: new Set<number>(),
      };
      const ownerScopes = scopesByOwner.get(ownerId) ?? [];
      ownerScopes.push(scope);
      scopesByOwner.set(ownerId, ownerScopes);
      return scope.id;
    },
    retain(ownerId, handlerRef) {
      const id = registry.retain(handlerRef);
      if (ownerId === undefined) {
        return id;
      }
      const ownerScopes = scopesByOwner.get(ownerId);
      const activeScope = ownerScopes?.at(-1);
      if (activeScope) {
        activeScope.retainedIds.add(id);
        return id;
      }
      return id;
    },
    endScope(ownerId, scopeId) {
      const ownerScopes = scopesByOwner.get(ownerId);
      const scope = ownerScopes?.at(-1);
      if (!ownerScopes || scope?.id !== scopeId) {
        throw new Error(
          `retained callback scope ${scopeId} is not active for owner ${String(ownerId)}`,
        );
      }
      ownerScopes.pop();
      if (ownerScopes.length === 0) {
        scopesByOwner.delete(ownerId);
      }
      releaseScopes([scope]);
    },
    finishOwner(ownerId) {
      const ownerScopes = scopesByOwner.get(ownerId) ?? [];
      scopesByOwner.delete(ownerId);
      const retainedIds = ownerScopes.flatMap((scope) =>
        Array.from(scope.retainedIds),
      );
      if (retainedIds.length > 0) {
        registry.releaseMany(retainedIds);
      }
    },
  };
}
