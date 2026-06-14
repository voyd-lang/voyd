import type {
  NormalizedEventPayload,
  VxAppRuntime,
  VxRuntimeEventMessage,
  VxRuntimeMapMessage,
  VxRuntimeMessage,
  VxRuntimeStep,
  VxRuntimeSubscriptionMessage,
} from "./types.js";

export type VoydVxAppHost = {
  run<T = unknown>(entryName: string, args?: unknown[]): Promise<T>;
  hasExport?: (entryName: string) => boolean;
  registerHandlersByLabelSuffix?: (
    handlersByLabelSuffix: Record<string, ComponentEffectHandler>,
  ) => unknown;
  retainedCallbacks?: {
    dispatch(id: number, payload: unknown): Promise<unknown> | unknown;
  };
};

type ComponentEffectHandler = (continuation: any, ...args: any[]) => any;

export type VoydVxAppRuntimeExports = {
  init?: string;
  update?: string;
  view?: string;
  subscriptions?: string;
};

export type CreateVoydVxAppRuntimeOptions = {
  host: VoydVxAppHost;
  initialModel?: unknown;
  app?: string | false;
  exports?: VoydVxAppRuntimeExports;
  viewReceivesModel?: boolean;
};

type RuntimeResult = Record<string, unknown> & {
  $vx: "runtime_result";
  model?: unknown;
  frame?: unknown;
  commands?: unknown;
  subscriptions?: unknown;
};

type ProgramDescriptor = {
  initHandlerId: number;
  updateHandlerId: number;
  viewHandlerId: number;
  subscriptionsHandlerId?: number;
};

type TaskObserver = (taskId: number) => Promise<unknown>;

const taskObserverProperty = Symbol.for("voyd.taskObserver");

const defaultExports = {
  init: "init",
  update: "update",
  view: "view",
} satisfies Required<Omit<VoydVxAppRuntimeExports, "subscriptions">>;

const runtimeResult = (value: Omit<RuntimeResult, "$vx">): RuntimeResult => ({
  $vx: "runtime_result",
  ...value,
});

const noRuntimeMessage = Symbol("vx.noRuntimeMessage");

export function createVoydVxAppRuntime(
  options: CreateVoydVxAppRuntimeOptions,
): VxAppRuntime {
  const entryNames = { ...defaultExports, ...options.exports };
  const appEntryName = options.app === false ? undefined : options.app ?? "app";
  const shouldUseProgramDescriptor =
    !options.exports &&
    appEntryName !== undefined &&
    options.host.hasExport?.(appEntryName) === true;
  let programDescriptor: ProgramDescriptor | undefined;
  let model = options.initialModel;
  let initialized = Object.hasOwn(options, "initialModel");
  const componentState = createComponentStateRuntime(options.host);

  const requireModel = (): unknown => {
    if (!initialized) {
      throw new Error("vx-dom: Voyd VX app runtime has not been initialized");
    }
    return model;
  };

  const requireRetainedCallbacks = () => {
    if (!options.host.retainedCallbacks) {
      throw new Error("vx-dom: Program descriptors require retained callback support");
    }
    return options.host.retainedCallbacks;
  };

  const readProgramDescriptor = async (): Promise<ProgramDescriptor | undefined> => {
    if (!shouldUseProgramDescriptor || !appEntryName) return undefined;
    if (programDescriptor) return programDescriptor;
    programDescriptor = parseProgramDescriptor(await options.host.run(appEntryName));
    return programDescriptor;
  };

  const runProgramHandler = async <T = unknown>(
    handlerId: number,
    payload: unknown,
  ): Promise<T> =>
    await Promise.resolve(requireRetainedCallbacks().dispatch(handlerId, payload) as T);

  const render = async (): Promise<unknown> => {
    let frame: unknown;
    for (let pass = 0; pass < 5; pass += 1) {
      componentState.resetDirty();
      componentState.beginRender();
      const descriptor = await readProgramDescriptor();
      frame = descriptor
        ? await runProgramHandler(descriptor.viewHandlerId, requireModel())
        : await options.host.run(
            entryNames.view,
            options.viewReceivesModel === false ? [] : [requireModel()],
          );
      componentState.finishRender(frame);
      if (!componentState.isDirty()) return frame;
    }
    return frame;
  };

  const readSubscriptions = async (): Promise<unknown> =>
    readProgramDescriptor().then((descriptor) =>
      descriptor?.subscriptionsHandlerId !== undefined
        ? runProgramHandler(descriptor.subscriptionsHandlerId, requireModel())
        : entryNames.subscriptions
          ? options.host.run(entryNames.subscriptions, [requireModel()])
          : undefined,
    );

  const toRuntimeStep = async (
    result: unknown,
    adoptPlainModel: boolean,
  ): Promise<VxRuntimeStep> => {
    const runtimeResult = isRuntimeResult(result) ? result : undefined;
    if (runtimeResult && Object.hasOwn(runtimeResult, "model")) {
      model = runtimeResult.model;
      initialized = true;
    } else if (adoptPlainModel) {
      model = result;
      initialized = true;
    }

    const frame = Object.hasOwn(runtimeResult ?? {}, "frame")
      ? runtimeResult?.frame
      : await render();
    const subscriptions = Object.hasOwn(runtimeResult ?? {}, "subscriptions")
      ? runtimeResult?.subscriptions
      : await readSubscriptions();

    const commands = attachTaskObserver(
      runtimeResult?.commands,
      readTaskObserver(result),
    );

    return {
      frame,
      commands,
      subscriptions,
      snapshot: model,
    };
  };

  return {
    init: async () => {
      const descriptor = await readProgramDescriptor();
      const result = initialized
        ? runtimeResult({ model })
        : descriptor
          ? await runProgramHandler(descriptor.initHandlerId, undefined)
          : await options.host.run(entryNames.init);
      return toRuntimeStep(result, true);
    },
    render,
    dispatch: async (message) => {
      const resolved = await resolveRuntimeMessage(options.host, message);
      if (resolved === noRuntimeMessage) {
        return toRuntimeStep(runtimeResult({ model: requireModel() }), false);
      }
      const descriptor = await readProgramDescriptor();
      const result = descriptor
        ? await runProgramHandler(descriptor.updateHandlerId, [requireModel(), resolved])
        : await options.host.run(entryNames.update, [
            requireModel(),
            resolved,
          ]);
      return toRuntimeStep(result, true);
    },
    getSnapshot: () => model,
  };
}

function createComponentStateRuntime(host: VoydVxAppHost): {
  beginRender(): void;
  finishRender(frame: unknown): void;
  isDirty(): boolean;
  resetDirty(): void;
} {
  let dirty = false;
  let nextSlotId = 1;
  const values = new Map<number, unknown>();
  const slots = new Map<string, number>();
  const renderOccurrences = new Map<string, number>();
  const scopeStack: string[] = [];

  const slotFor = (baseId: number, occurrence: number): number => {
    const key = slotKey(baseId, scopeStack, occurrence);
    const existing = slots.get(key);
    if (existing !== undefined) return existing;
    const slot = nextSlotId;
    nextSlotId += 1;
    slots.set(key, slot);
    return slot;
  };

  host.registerHandlersByLabelSuffix?.({
    "Component::state_scope": ({ tail }, key) => {
      scopeStack.push(scopePartFor(key));
      try {
        const result = tail();
        if (result && typeof result === "object" && "finally" in result) {
          return (result as Promise<unknown>).finally(() => {
            scopeStack.pop();
          });
        }
        scopeStack.pop();
        return result;
      } catch (error) {
        scopeStack.pop();
        throw error;
      }
    },
    "Component::state_key": ({ tail }, id) => {
      const baseId = Number(id);
      const occurrenceKey = slotKey(baseId, scopeStack, -1);
      const occurrence = renderOccurrences.get(occurrenceKey) ?? 0;
      renderOccurrences.set(occurrenceKey, occurrence + 1);
      const slot = slotFor(baseId, occurrence);
      return tail(slot);
    },
    "Component::state_get": ({ tail }, id, initial) => {
      const key = Number(id);
      if (!values.has(key)) values.set(key, initial);
      return tail(values.get(key));
    },
    "Component::state_set": ({ tail }, id, value) => {
      values.set(Number(id), value);
      dirty = true;
      return tail();
    },
    "Component::task_started": ({ tail }) => tail(),
  });

  return {
    beginRender: () => {
      renderOccurrences.clear();
    },
    finishRender: () => undefined,
    isDirty: () => dirty,
    resetDirty: () => {
      dirty = false;
    },
  };
}

const slotKey = (
  baseId: number,
  scopeStack: readonly string[],
  occurrence: number,
): string => `${baseId}:${JSON.stringify(scopeStack)}:${occurrence}`;

const scopePartFor = (value: unknown): string =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : JSON.stringify(value);

async function resolveRuntimeMessage(
  host: VoydVxAppHost,
  message: VxRuntimeMessage,
): Promise<unknown> {
  if (message.kind === "msgpack") return message.value;
  if (message.kind === "event") return resolveEventMessage(host, message);
  if (message.kind === "subscription") return resolveSubscriptionMessage(message);
  if (message.kind === "map") return resolveMapMessage(host, message);
  return message;
}

async function resolveEventMessage(
  host: VoydVxAppHost,
  message: VxRuntimeEventMessage,
): Promise<unknown> {
  if (!host.retainedCallbacks) {
    return eventPayloadFallback(message.payload);
  }
  const result = await host.retainedCallbacks.dispatch(
    message.handlerId,
    message.payload,
  );
  return result === undefined ? noRuntimeMessage : result;
}

async function resolveMapMessage(
  host: VoydVxAppHost,
  message: VxRuntimeMapMessage,
): Promise<unknown> {
  const child = await resolveRuntimeMessage(host, message.message);
  if (child === noRuntimeMessage) {
    return noRuntimeMessage;
  }
  return host.retainedCallbacks?.dispatch(message.handlerId, child) ?? child;
}

function resolveSubscriptionMessage(message: VxRuntimeSubscriptionMessage): unknown {
  return Object.hasOwn(message, "value") ? message.value : message.payload;
}

function eventPayloadFallback(payload: NormalizedEventPayload): unknown {
  return payload;
}

function readTaskObserver(input: unknown): TaskObserver | undefined {
  if (!isRecord(input)) return undefined;
  const observer = input[taskObserverProperty];
  return typeof observer === "function" ? observer as TaskObserver : undefined;
}

function attachTaskObserver(input: unknown, observer: TaskObserver | undefined): unknown {
  if (!observer || !isRecord(input)) return input;
  Object.defineProperty(input, taskObserverProperty, {
    configurable: true,
    enumerable: false,
    value: observer,
  });
  return input;
}

function isRuntimeResult(input: unknown): input is RuntimeResult {
  return (
    !!input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    (input as { $vx?: unknown }).$vx === "runtime_result"
  );
}

function isRecord(input: unknown): input is Record<PropertyKey, unknown> {
  return typeof input === "object" && input !== null;
}

function parseProgramDescriptor(input: unknown): ProgramDescriptor {
  if (readField(input, "kind") !== "program") {
    throw new Error("vx-dom: app export did not return a VX program descriptor");
  }
  const initHandlerId = readNumberField(input, "initHandlerId");
  const updateHandlerId = readNumberField(input, "updateHandlerId");
  const viewHandlerId = readNumberField(input, "viewHandlerId");
  const subscriptionsHandlerId = readOptionalNumberField(
    input,
    "subscriptionsHandlerId",
  );
  return {
    initHandlerId,
    updateHandlerId,
    viewHandlerId,
    ...(subscriptionsHandlerId !== undefined ? { subscriptionsHandlerId } : {}),
  };
}

function readNumberField(input: unknown, name: string): number {
  const value = readField(input, name);
  if (typeof value !== "number") {
    throw new Error(`vx-dom: program descriptor field ${name} must be a number`);
  }
  return value;
}

function readOptionalNumberField(input: unknown, name: string): number | undefined {
  const value = readField(input, name);
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw new Error(`vx-dom: program descriptor field ${name} must be a number`);
  }
  return value;
}

function readField(input: unknown, name: string): unknown {
  if (input instanceof Map) {
    return input.get(name);
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return (input as Record<string, unknown>)[name];
  }
  return undefined;
}
