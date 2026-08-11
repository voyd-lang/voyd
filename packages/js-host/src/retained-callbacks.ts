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
  claim(ownerId: RetainedCallbackScopeOwner, handlerId: number): void;
  endScope(ownerId: RetainedCallbackScopeOwner, scopeId: number): void;
  finishOwner(ownerId: RetainedCallbackScopeOwner): void;
};

export type RetainedCallbackScopeOwner = number | string | symbol;

type OpaqueCapabilityAllocator = {
  allocate(): number;
  owns(token: number): boolean;
};

const issuedOpaqueCapabilities = new Set<number>();

export const createOpaqueCapabilityAllocator = (): OpaqueCapabilityAllocator => {
  const owned = new Set<number>();
  return {
    allocate() {
      for (let attempt = 0; attempt < 128; attempt += 1) {
        const random = new Uint32Array(1);
        globalThis.crypto.getRandomValues(random);
        const token = random[0]! & 0x7fff_ffff;
        if (token === 0 || issuedOpaqueCapabilities.has(token)) continue;
        issuedOpaqueCapabilities.add(token);
        owned.add(token);
        return token;
      }
      throw new Error("opaque capability token allocation failed");
    },
    owns(token) {
      return Number.isInteger(token) && token > 0 && owned.has(token);
    },
  };
};

export function createRetainedEventHandlerRegistry<Payload = unknown>(): RetainedEventHandlerRegistry<Payload> {
  const capabilities = createOpaqueCapabilityAllocator();
  const handlers = new Map<number, WasmEventHandlerRef<Payload>>();

  const resolve = (token: number): WasmEventHandlerRef<Payload> => {
    if (!capabilities.owns(token)) {
      throw new Error("retained callback belongs to a different runtime session");
    }
    const handler = handlers.get(token);
    if (!handler) {
      throw new Error("retained callback is stale or has already completed");
    }
    return handler;
  };

  return {
    retain(handlerRef) {
      const token = capabilities.allocate();
      handlers.set(token, handlerRef);
      return token;
    },
    async dispatch(token, payload) {
      return await resolve(token)(payload);
    },
    release(token) {
      resolve(token);
      handlers.delete(token);
    },
    releaseMany(tokens) {
      Array.from(tokens).forEach((token) => {
        resolve(token);
        handlers.delete(token);
      });
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
  const unscopedIdsByOwner = new Map<RetainedCallbackScopeOwner, Set<number>>();
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
      const unscopedIds = unscopedIdsByOwner.get(ownerId) ?? new Set<number>();
      unscopedIds.add(id);
      unscopedIdsByOwner.set(ownerId, unscopedIds);
      return id;
    },
    claim(ownerId, handlerId) {
      const unscopedIds = unscopedIdsByOwner.get(ownerId);
      if (!unscopedIds?.has(handlerId)) {
        return;
      }
      const activeScope = scopesByOwner.get(ownerId)?.at(-1);
      if (!activeScope) {
        throw new Error(
          `cannot claim retained callback ${handlerId} without an active scope for owner ${String(ownerId)}`,
        );
      }
      unscopedIds.delete(handlerId);
      if (unscopedIds.size === 0) {
        unscopedIdsByOwner.delete(ownerId);
      }
      activeScope.retainedIds.add(handlerId);
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
      unscopedIdsByOwner.delete(ownerId);
      const retainedIds = ownerScopes.flatMap((scope) =>
        Array.from(scope.retainedIds),
      );
      if (retainedIds.length > 0) {
        registry.releaseMany(retainedIds);
      }
    },
  };
}
