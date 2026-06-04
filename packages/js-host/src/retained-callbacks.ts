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
