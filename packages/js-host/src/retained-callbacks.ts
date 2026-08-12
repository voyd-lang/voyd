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
};

const CAPABILITY_MASK = 0x7fff_ffff;
let nextCapabilityInput = 1;
let capabilityMixingKeys: readonly [number, number, number] | undefined;

const getCapabilityMixingKeys = (): readonly [number, number, number] => {
  if (capabilityMixingKeys) return capabilityMixingKeys;
  const random = new Uint32Array(3);
  globalThis.crypto.getRandomValues(random);
  capabilityMixingKeys = [
    random[0]! & CAPABILITY_MASK,
    (random[1]! | 1) & CAPABILITY_MASK,
    (random[2]! | 1) & CAPABILITY_MASK,
  ];
  return capabilityMixingKeys;
};

const mixCapability = (input: number): number => {
  const [xorKey, firstMultiplier, secondMultiplier] =
    getCapabilityMixingKeys();
  let mixed = (input ^ xorKey) & CAPABILITY_MASK;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, firstMultiplier) & CAPABILITY_MASK;
  mixed ^= mixed >>> 13;
  mixed = Math.imul(mixed, secondMultiplier) & CAPABILITY_MASK;
  mixed ^= mixed >>> 16;
  return mixed & CAPABILITY_MASK;
};

const allocateOpaqueCapability = (): number => {
  while (nextCapabilityInput <= CAPABILITY_MASK) {
    const token = mixCapability(nextCapabilityInput++);
    if (token !== 0) return token;
  }
  throw new Error("opaque capability token space exhausted");
};

export const createOpaqueCapabilityAllocator = (): OpaqueCapabilityAllocator => {
  return {
    allocate: allocateOpaqueCapability,
  };
};

export function createRetainedEventHandlerRegistry<Payload = unknown>(): RetainedEventHandlerRegistry<Payload> {
  const capabilities = createOpaqueCapabilityAllocator();
  const handlers = new Map<number, WasmEventHandlerRef<Payload>>();

  const resolve = (token: number): WasmEventHandlerRef<Payload> => {
    const handler = handlers.get(token);
    if (!handler) {
      throw new Error(
        "retained callback is stale or has already completed or belongs to a different runtime session",
      );
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
