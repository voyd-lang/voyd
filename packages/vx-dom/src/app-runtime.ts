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
  exports?: VoydVxAppRuntimeExports;
  viewReceivesModel?: boolean;
};

type RuntimeResult = Record<string, unknown> & {
  model?: unknown;
  frame?: unknown;
  commands?: unknown;
  subscriptions?: unknown;
};

const defaultExports = {
  init: "init",
  update: "update",
  view: "view",
} satisfies Required<Omit<VoydVxAppRuntimeExports, "subscriptions">>;

export function createVoydVxAppRuntime(
  options: CreateVoydVxAppRuntimeOptions,
): VxAppRuntime {
  const entryNames = { ...defaultExports, ...options.exports };
  let model = options.initialModel;
  let initialized = Object.hasOwn(options, "initialModel");
  const componentState = createComponentStateRuntime(options.host);

  const requireModel = (): unknown => {
    if (!initialized) {
      throw new Error("vx-dom: Voyd VX app runtime has not been initialized");
    }
    return model;
  };

  const render = async (): Promise<unknown> => {
    let frame: unknown;
    for (let pass = 0; pass < 5; pass += 1) {
      componentState.resetDirty();
      frame = await options.host.run(
        entryNames.view,
        options.viewReceivesModel === false ? [] : [requireModel()],
      );
      if (!componentState.isDirty()) return frame;
    }
    return frame;
  };

  const readSubscriptions = async (): Promise<unknown> =>
    entryNames.subscriptions
      ? options.host.run(entryNames.subscriptions, [requireModel()])
      : undefined;

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

    return {
      frame,
      commands: runtimeResult?.commands,
      subscriptions,
      snapshot: model,
    };
  };

  return {
    init: async () => {
      const result = initialized
        ? { model }
        : await options.host.run(entryNames.init);
      return toRuntimeStep(result, true);
    },
    render,
    dispatch: async (message) => {
      const resolved = await resolveRuntimeMessage(options.host, message);
      const result = await options.host.run(entryNames.update, [
        requireModel(),
        resolved,
      ]);
      return toRuntimeStep(result, true);
    },
    getSnapshot: () => model,
  };
}

function createComponentStateRuntime(host: VoydVxAppHost): {
  isDirty(): boolean;
  resetDirty(): void;
} {
  let dirty = false;
  const values = new Map<number, unknown>();
  host.registerHandlersByLabelSuffix?.({
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
    isDirty: () => dirty,
    resetDirty: () => {
      dirty = false;
    },
  };
}

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
  return host.retainedCallbacks?.dispatch(message.handlerId, message.payload) ??
    eventPayloadFallback(message.payload);
}

async function resolveMapMessage(
  host: VoydVxAppHost,
  message: VxRuntimeMapMessage,
): Promise<unknown> {
  const child = await resolveRuntimeMessage(host, message.message);
  return host.retainedCallbacks?.dispatch(message.handlerId, child) ?? child;
}

function resolveSubscriptionMessage(message: VxRuntimeSubscriptionMessage): unknown {
  return Object.hasOwn(message, "value") ? message.value : message.payload;
}

function eventPayloadFallback(payload: NormalizedEventPayload): unknown {
  return payload;
}

function isRuntimeResult(input: unknown): input is RuntimeResult {
  return !!input && typeof input === "object" && !Array.isArray(input);
}
