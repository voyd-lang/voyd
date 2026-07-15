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
    release?: (id: number) => void;
    releaseMany?: (ids: Iterable<number>) => void;
  };
};

type ComponentEffectHandler = (continuation: any, ...args: any[]) => any;

export type VoydVxAppRuntimeExports = {
  init?: string;
  step?: string;
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
  kind: "program";
  initHandlerId: number;
  hydrateHandlerId?: number;
  stepHandlerId: number;
  viewHandlerId: number;
  subscriptionsHandlerId?: number;
} | {
  kind: "program_map_model";
  handlerId: number;
  hydrateHandlerId?: number;
  child: ProgramDescriptor;
} | {
  kind: "program_map_message";
  handlerId: number;
  child: ProgramDescriptor;
};

type TaskObserver = (taskId: number) => Promise<unknown>;
type RetainedDispatch = (handlerId: number, payload: unknown) => Promise<unknown>;

type ProgramDescriptorRunner = {
  hydrate(model: unknown): Promise<RuntimeResult>;
  init(): Promise<RuntimeResult>;
  step(message: VxRuntimeMessage): Promise<RuntimeResult>;
  view(): Promise<unknown>;
  subscriptions(): Promise<unknown>;
};

const taskObserverProperty = Symbol.for("voyd.taskObserver");

const defaultExports = {
  init: "init",
  step: "step",
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
  let programRunner: ProgramDescriptorRunner | undefined;
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

  const readProgramRunner = async (): Promise<ProgramDescriptorRunner | undefined> => {
    if (!shouldUseProgramDescriptor || !appEntryName) return undefined;
    if (programRunner) return programRunner;
    programRunner = createProgramDescriptorRunner({
      descriptor: parseProgramDescriptor(await options.host.run(appEntryName)),
      host: options.host,
      dispatch: runProgramHandler,
    });
    return programRunner;
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
      const descriptor = await readProgramRunner();
      frame = descriptor
        ? await descriptor.view()
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
    readProgramRunner().then((descriptor) =>
      descriptor
        ? descriptor.subscriptions()
        : entryNames.subscriptions
          ? options.host.run(entryNames.subscriptions, [requireModel()])
          : undefined,
    );

  const toRuntimeStep = async (
    result: unknown,
    adoptPlainModel: boolean,
  ): Promise<VxRuntimeStep> => {
    const resolvedResult = await resolveProgramResultMaps(
      result,
      runProgramHandler,
    );
    const runtimeResult = isRuntimeResult(resolvedResult)
      ? resolvedResult
      : undefined;
    if (runtimeResult && Object.hasOwn(runtimeResult, "model")) {
      model = runtimeResult.model;
      initialized = true;
    } else if (adoptPlainModel) {
      model = resolvedResult;
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
      readTaskObserver(resolvedResult) ?? readTaskObserver(result),
    );

    return {
      frame,
      commands,
      subscriptions,
      snapshot: model,
    };
  };

  return {
    retainedCallbacks: options.host.retainedCallbacks,
    init: async () => {
      const descriptor = await readProgramRunner();
      if (initialized && descriptor) {
        const result = await descriptor.hydrate(model);
        return toRuntimeStep(result, true);
      }
      const result = initialized
        ? descriptor
          ? await descriptor.init()
          : runtimeResult({ model })
        : descriptor
          ? await descriptor.init()
          : await options.host.run(entryNames.init);
      return toRuntimeStep(result, true);
    },
    render,
    dispatch: async (message) => {
      const descriptor = await readProgramRunner();
      if (!descriptor) {
        const resolved = await resolveRuntimeMessage(options.host, message);
        if (resolved === noRuntimeMessage) {
          return toRuntimeStep(runtimeResult({ model: requireModel() }), false);
        }
        const result = await options.host.run(entryNames.step, [
          requireModel(),
          resolved,
        ]);
        return toRuntimeStep(result, true);
      }

      const result = descriptor
        ? await descriptor.step(message)
        : runtimeResult({ model: requireModel() });
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

function createProgramDescriptorRunner({
  descriptor,
  host,
  dispatch,
}: {
  descriptor: ProgramDescriptor;
  host: VoydVxAppHost;
  dispatch: RetainedDispatch;
}): ProgramDescriptorRunner {
  if (descriptor.kind === "program_map_model") {
    const child = createProgramDescriptorRunner({
      descriptor: descriptor.child,
      host,
      dispatch,
    });
    const mapModel = async (result: RuntimeResult): Promise<RuntimeResult> => {
      const modelInput = Object.hasOwn(result, "model")
        ? result.model
        : undefined;
      const mappedModel = await dispatch(descriptor.handlerId, modelInput);
      return copyTaskObserver(result, { ...result, model: mappedModel }) as RuntimeResult;
    };
    return {
      hydrate: async (model) => {
        if (descriptor.hydrateHandlerId === undefined) {
          throw new Error(
            "vx-dom: mapped-model programs require a hydrate mapper to adopt an SSR model",
          );
        }
        const childModel = await dispatch(descriptor.hydrateHandlerId, model);
        return mapModel(await child.hydrate(childModel));
      },
      init: async () => mapModel(await child.init()),
      step: async (message) => mapModel(await child.step(message)),
      view: () => child.view(),
      subscriptions: () => child.subscriptions(),
    };
  }

  if (descriptor.kind === "program_map_message") {
    const child = createProgramDescriptorRunner({
      descriptor: descriptor.child,
      host,
      dispatch,
    });
    const mapMessages = (result: RuntimeResult): RuntimeResult =>
      copyTaskObserver(result, {
        ...result,
        ...(Object.hasOwn(result, "frame")
          ? { frame: mapProgramFrame(result.frame, descriptor.handlerId) }
          : {}),
        ...(Object.hasOwn(result, "commands")
          ? { commands: mapProgramEnvelope(result.commands, "cmd", descriptor.handlerId) }
          : {}),
        ...(Object.hasOwn(result, "subscriptions")
          ? {
              subscriptions: mapProgramEnvelope(
                result.subscriptions,
                "sub",
                descriptor.handlerId,
              ),
            }
          : {}),
      }) as RuntimeResult;
    return {
      hydrate: async (model) => {
        return mapMessages(await child.hydrate(model));
      },
      init: async () => mapMessages(await child.init()),
      step: async (message) => {
        const childMessage =
          message.kind === "map" && message.handlerId === descriptor.handlerId
            ? message.message
            : message;
        return mapMessages(await child.step(childMessage));
      },
      view: async () => mapProgramFrame(await child.view(), descriptor.handlerId),
      subscriptions: async () =>
        mapProgramEnvelope(
          await child.subscriptions(),
          "sub",
          descriptor.handlerId,
        ),
    };
  }

  let model: unknown;
  let initialized = false;
  const requireLocalModel = (): unknown => {
    if (!initialized) {
      throw new Error("vx-dom: Voyd VX app runtime has not been initialized");
    }
    return model;
  };
  const adoptResult = (
    result: unknown,
    adoptPlainModel: boolean,
  ): RuntimeResult => {
    if (isRuntimeResult(result)) {
      if (Object.hasOwn(result, "model")) {
        model = result.model;
        initialized = true;
      }
      return result;
    }
    if (adoptPlainModel) {
      model = result;
      initialized = true;
      return runtimeResult({ model: result });
    }
    return runtimeResult({ model: requireLocalModel() });
  };
  const adoptLifecycleResult = async (
    result: unknown,
    adoptPlainModel: boolean,
  ): Promise<RuntimeResult> =>
    adoptResult(await resolveProgramResultMaps(result, dispatch), adoptPlainModel);

  return {
    hydrate: async (nextModel) => {
      model = nextModel;
      initialized = true;
      if (descriptor.hydrateHandlerId === undefined) {
        return runtimeResult({ model: nextModel });
      }
      return adoptLifecycleResult(
        await dispatch(descriptor.hydrateHandlerId, nextModel),
        true,
      );
    },
    init: async () =>
      adoptLifecycleResult(await dispatch(descriptor.initHandlerId, undefined), true),
    step: async (message) => {
      const resolved = await resolveRuntimeMessage(host, message);
      if (resolved === noRuntimeMessage) {
        return runtimeResult({ model: requireLocalModel() });
      }
      return adoptLifecycleResult(
        await dispatch(descriptor.stepHandlerId, [requireLocalModel(), resolved]),
        true,
      );
    },
    view: () => dispatch(descriptor.viewHandlerId, requireLocalModel()),
    subscriptions: () =>
      descriptor.subscriptionsHandlerId !== undefined
        ? dispatch(descriptor.subscriptionsHandlerId, requireLocalModel())
        : Promise.resolve(undefined),
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

async function resolveProgramResultMaps(
  input: unknown,
  dispatch: RetainedDispatch,
): Promise<unknown> {
  if (!isRecord(input)) return input;

  if (input.kind === "program_map_model") {
    const child = await resolveProgramResultMaps(input.child, dispatch);
    const handlerId = readProgramMapHandlerId(input, "program_map_model");
    const modelInput = isRuntimeResult(child) && Object.hasOwn(child, "model")
      ? child.model
      : child;
    const mappedModel = await dispatch(handlerId, modelInput);
    if (!isRuntimeResult(child)) return mappedModel;
    return copyTaskObserver(child, { ...child, model: mappedModel });
  }

  if (input.kind === "program_map_message") {
    const child = await resolveProgramResultMaps(input.child, dispatch);
    if (!isRuntimeResult(child)) return child;
    const handlerId = readProgramMapHandlerId(input, "program_map_message");
    return copyTaskObserver(child, {
      ...child,
      ...(Object.hasOwn(child, "frame")
        ? { frame: mapProgramFrame(child.frame, handlerId) }
        : {}),
      ...(Object.hasOwn(child, "commands")
        ? { commands: mapProgramEnvelope(child.commands, "cmd", handlerId) }
        : {}),
      ...(Object.hasOwn(child, "subscriptions")
        ? { subscriptions: mapProgramEnvelope(child.subscriptions, "sub", handlerId) }
        : {}),
    });
  }

  return input;
}

function readProgramMapHandlerId(
  input: Record<PropertyKey, unknown>,
  kind: string,
): number {
  if (typeof input.handlerId !== "number") {
    throw new Error(`vx-dom: ${kind} missing numeric handlerId`);
  }
  return input.handlerId;
}

function copyTaskObserver(source: unknown, target: unknown): unknown {
  const observer = readTaskObserver(source);
  if (!observer || !isRecord(target)) return target;
  Object.defineProperty(target, taskObserverProperty, {
    configurable: true,
    enumerable: false,
    value: observer,
  });
  return target;
}

function mapProgramFrame(frame: unknown, handlerId: number): unknown {
  if (isRecord(frame) && frame.version === 1 && Object.hasOwn(frame, "root")) {
    return {
      ...frame,
      root: mapProgramHtml(frame.root, handlerId),
    };
  }
  return mapProgramHtml(frame, handlerId);
}

function mapProgramHtml(html: unknown, handlerId: number): unknown {
  return {
    kind: "map",
    child: html,
    handlerId,
  };
}

function mapProgramEnvelope(
  envelope: unknown,
  type: "cmd" | "sub",
  handlerId: number,
): unknown {
  if (envelope === undefined) return undefined;
  return {
    type,
    kind: "map",
    child: envelope,
    handlerId,
  };
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
  const kind = readField(input, "kind");
  if (kind === "program_map_model" || kind === "program_map_message") {
    const hydrateHandlerId = kind === "program_map_model"
      ? readOptionalNumberField(input, "hydrateHandlerId")
      : undefined;
    return {
      kind,
      handlerId: readNumberField(input, "handlerId"),
      ...(hydrateHandlerId !== undefined ? { hydrateHandlerId } : {}),
      child: parseProgramDescriptor(readField(input, "child")),
    };
  }

  if (kind !== "program") {
    throw new Error("vx-dom: app export did not return a VX program descriptor");
  }
  const initHandlerId = readNumberField(input, "initHandlerId");
  const hydrateHandlerId = readOptionalNumberField(input, "hydrateHandlerId");
  const stepHandlerId = readNumberField(input, "stepHandlerId");
  const viewHandlerId = readNumberField(input, "viewHandlerId");
  const subscriptionsHandlerId = readOptionalNumberField(
    input,
    "subscriptionsHandlerId",
  );
  return {
    kind: "program",
    initHandlerId,
    ...(hydrateHandlerId !== undefined ? { hydrateHandlerId } : {}),
    stepHandlerId,
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
