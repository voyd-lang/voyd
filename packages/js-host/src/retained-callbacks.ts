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

const SESSION_BITS = 10;
const GENERATION_BITS = 8;
const SLOT_BITS = 31 - SESSION_BITS - GENERATION_BITS;
const SLOT_MASK = (1 << SLOT_BITS) - 1;
const GENERATION_MASK = (1 << GENERATION_BITS) - 1;
const SESSION_MASK = (1 << SESSION_BITS) - 1;
let nextRegistrySession = 1;

type RetainedHandlerSlot<Payload> = {
  generation: number;
  handler?: WasmEventHandlerRef<Payload>;
};

export function createRetainedEventHandlerRegistry<Payload = unknown>(): RetainedEventHandlerRegistry<Payload> {
  const session = allocateRegistrySession();
  const slots: RetainedHandlerSlot<Payload>[] = [];
  const freeSlots: number[] = [];

  const resolve = (token: number): RetainedHandlerSlot<Payload> => {
    const decoded = decodeCapabilityToken(token);
    if (decoded.session !== session) {
      throw new Error("retained callback belongs to a different runtime session");
    }
    const slot = slots[decoded.slot];
    if (!slot || slot.generation !== decoded.generation || !slot.handler) {
      throw new Error("retained callback is stale or has already completed");
    }
    return slot;
  };

  return {
    retain(handlerRef) {
      const slotIndex = freeSlots.pop() ?? slots.length;
      if (slotIndex > SLOT_MASK) {
        throw new Error("retained callback registry exhausted its slot capacity");
      }
      const prior = slots[slotIndex];
      const generation = nextGeneration(prior?.generation ?? 0);
      slots[slotIndex] = { generation, handler: handlerRef };
      return encodeCapabilityToken({ session, slot: slotIndex, generation });
    },
    async dispatch(token, payload) {
      return await resolve(token).handler!(payload);
    },
    release(token) {
      const decoded = decodeCapabilityToken(token);
      const slot = resolve(token);
      slot.handler = undefined;
      freeSlots.push(decoded.slot);
    },
    releaseMany(tokens) {
      Array.from(tokens).forEach((token) => {
        const decoded = decodeCapabilityToken(token);
        const slot = resolve(token);
        slot.handler = undefined;
        freeSlots.push(decoded.slot);
      });
    },
    clear() {
      slots.forEach((slot, index) => {
        if (!slot.handler) return;
        slot.handler = undefined;
        freeSlots.push(index);
      });
    },
    size() {
      return slots.reduce((count, slot) => count + (slot.handler ? 1 : 0), 0);
    },
  };
}

const allocateRegistrySession = (): number => {
  if (nextRegistrySession > SESSION_MASK) {
    throw new Error("retained callback runtime session capacity exhausted");
  }
  return nextRegistrySession++;
};

const nextGeneration = (generation: number): number => {
  const next = (generation + 1) & GENERATION_MASK;
  return next === 0 ? 1 : next;
};

const encodeCapabilityToken = ({
  session,
  slot,
  generation,
}: {
  session: number;
  slot: number;
  generation: number;
}): number =>
  (session << (GENERATION_BITS + SLOT_BITS)) |
  (generation << SLOT_BITS) |
  slot;

const decodeCapabilityToken = (
  token: number,
): { session: number; slot: number; generation: number } => {
  if (!Number.isInteger(token) || token <= 0) {
    throw new Error("invalid retained callback capability token");
  }
  return {
    session: (token >>> (GENERATION_BITS + SLOT_BITS)) & SESSION_MASK,
    generation: (token >>> SLOT_BITS) & GENERATION_MASK,
    slot: token & SLOT_MASK,
  };
};

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
