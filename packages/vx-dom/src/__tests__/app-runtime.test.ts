import { describe, expect, it, vi } from "vitest";
import { createVoydVxAppRuntime, type VoydVxAppHost } from "../app-runtime.js";

describe("createVoydVxAppRuntime", () => {
  it("keeps model ownership in Voyd exports", async () => {
    let model = "intro";
    const host = fakeHost({
      init: async () => model,
      view: async ([current]) => textFrame(`Page: ${String(current)}`),
      step: async ([current, message]) => {
        model = message === "state" ? "state" : String(current);
        return model;
      },
      subscriptions: async ([current]) => ({
        type: "sub",
        kind: "keyboard",
        key: String(current),
      }),
    });
    const app = createVoydVxAppRuntime({
      host,
      exports: { subscriptions: "subscriptions" },
    });

    await expect(app.init?.()).resolves.toEqual({
      frame: textFrame("Page: intro"),
      commands: undefined,
      subscriptions: { type: "sub", kind: "keyboard", key: "intro" },
      snapshot: "intro",
    });

    await expect(app.dispatch({ kind: "msgpack", value: "state" })).resolves.toEqual({
      frame: textFrame("Page: state"),
      commands: undefined,
      subscriptions: { type: "sub", kind: "keyboard", key: "state" },
      snapshot: "state",
    });
    expect(app.getSnapshot?.()).toBe("state");
  });

  it("passes commands and explicit frames through runtime result objects", async () => {
    const host = fakeHost({
      init: async () => ({
        $vx: "runtime_result",
        model: 0,
        frame: textFrame("Boot"),
        commands: { type: "cmd", kind: "message", value: "tick" },
      }),
      view: async ([count]) => textFrame(`Count: ${String(count)}`),
      step: async ([count]) => ({
        $vx: "runtime_result",
        model: Number(count) + 1,
        frame: textFrame("Updated"),
        commands: { type: "cmd", kind: "none" },
      }),
    });
    const app = createVoydVxAppRuntime({ host });

    await expect(app.init?.()).resolves.toEqual({
      frame: textFrame("Boot"),
      commands: { type: "cmd", kind: "message", value: "tick" },
      subscriptions: undefined,
      snapshot: 0,
    });
    await expect(app.dispatch({ kind: "msgpack", value: "tick" })).resolves.toEqual({
      frame: textFrame("Updated"),
      commands: { type: "cmd", kind: "none" },
      subscriptions: undefined,
      snapshot: 1,
    });
  });

  it("treats plain object results as models even when they use runtime field names", async () => {
    const firstModel = {
      model: "nested",
      commands: "not-a-command",
      frame: "not-a-frame",
    };
    const secondModel = {
      model: "updated",
      commands: "still-not-a-command",
      frame: "still-not-a-frame",
    };
    const host = fakeHost({
      init: async () => firstModel,
      view: async ([current]) => textFrame(`Model: ${JSON.stringify(current)}`),
      step: async () => secondModel,
    });
    const app = createVoydVxAppRuntime({ host });

    await expect(app.init?.()).resolves.toEqual({
      frame: textFrame(`Model: ${JSON.stringify(firstModel)}`),
      commands: undefined,
      subscriptions: undefined,
      snapshot: firstModel,
    });
    await expect(app.dispatch({ kind: "msgpack", value: "tick" })).resolves.toEqual({
      frame: textFrame(`Model: ${JSON.stringify(secondModel)}`),
      commands: undefined,
      subscriptions: undefined,
      snapshot: secondModel,
    });
  });

  it("resolves retained event and mapped runtime messages before step", async () => {
    const seenMessages: unknown[] = [];
    const retainedDispatch = vi.fn(async (id: number, payload: unknown) => ({
      id,
      payload,
    }));
    const host = fakeHost({
      init: async () => "ready",
      view: async ([current]) => textFrame(String(current)),
      step: async ([current, message]) => {
        seenMessages.push(message);
        return current;
      },
    });
    host.retainedCallbacks = { dispatch: retainedDispatch };
    const app = createVoydVxAppRuntime({ host });

    await app.init?.();
    await app.dispatch({
      kind: "event",
      handlerId: 7,
      payload: { kind: "event", event: "focus" },
    });
    await app.dispatch({
      kind: "map",
      handlerId: 9,
      message: { kind: "msgpack", value: "child" },
    });

    expect(seenMessages).toEqual([
      { id: 7, payload: { kind: "event", event: "focus" } },
      { id: 9, payload: "child" },
    ]);
  });

  it("rerenders mapped local-only retained callbacks without step or mapper dispatch", async () => {
    const seenMessages: unknown[] = [];
    const retainedDispatch = vi.fn(async (id: number) => {
      if (id === 7) return undefined;
      throw new Error(`unexpected retained mapper ${id}`);
    });
    const host = fakeHost({
      init: async () => "ready",
      view: async ([current]) => textFrame(`View: ${String(current)}`),
      step: async ([current, message]) => {
        seenMessages.push(message);
        return current;
      },
    });
    host.retainedCallbacks = { dispatch: retainedDispatch };
    const app = createVoydVxAppRuntime({ host });

    await app.init?.();
    await expect(
      app.dispatch({
        kind: "map",
        handlerId: 9,
        message: {
          kind: "event",
          handlerId: 7,
          payload: { kind: "event", event: "click" },
        },
      }),
    ).resolves.toEqual({
      frame: textFrame("View: ready"),
      commands: undefined,
      subscriptions: undefined,
      snapshot: "ready",
    });

    expect(seenMessages).toEqual([]);
    expect(retainedDispatch).toHaveBeenCalledTimes(1);
    expect(retainedDispatch).toHaveBeenCalledWith(7, {
      kind: "event",
      event: "click",
    });
  });

  it("uses stepHandlerId from program descriptors", async () => {
    const retainedDispatch = vi.fn(async (id: number, payload: unknown) => {
      if (id === 1) return "ready";
      if (id === 2) return `stepped:${String((payload as unknown[])[1])}`;
      if (id === 3) return textFrame(`View: ${String(payload)}`);
      throw new Error(`unexpected retained handler ${id}`);
    });
    const host = fakeHost({
      app: async () => ({
        kind: "program",
        initHandlerId: 1,
        stepHandlerId: 2,
        viewHandlerId: 3,
      }),
    });
    host.hasExport = (entryName) => entryName === "app";
    host.retainedCallbacks = { dispatch: retainedDispatch };
    const app = createVoydVxAppRuntime({ host });

    await expect(app.init?.()).resolves.toEqual({
      frame: textFrame("View: ready"),
      commands: undefined,
      subscriptions: undefined,
      snapshot: "ready",
    });
    await expect(app.dispatch({ kind: "msgpack", value: "tick" })).resolves.toEqual({
      frame: textFrame("View: stepped:tick"),
      commands: undefined,
      subscriptions: undefined,
      snapshot: "stepped:tick",
    });
  });

  it("keeps repeated component state call-site occurrences in distinct slots", async () => {
    let handlers: Record<string, (continuation: any, ...args: any[]) => unknown> = {};
    let slots: number[] = [];
    const callComponent = (name: string, ...args: unknown[]) =>
      handlers[name]?.({ tail: (value?: unknown) => value }, ...args);
    const host: VoydVxAppHost = {
      registerHandlersByLabelSuffix: (nextHandlers) => {
        handlers = nextHandlers;
      },
      run: async <T = unknown>(entryName: string): Promise<T> => {
        if (entryName !== "view") {
          throw new Error(`unexpected fake entry ${entryName}`);
        }
        const firstSlot = Number(callComponent("Component::state_key", 1234));
        const first = callComponent("Component::state_get", firstSlot, 0);
        const secondSlot = Number(callComponent("Component::state_key", 1234));
        const second = callComponent("Component::state_get", secondSlot, 0);
        slots = [firstSlot, secondSlot];
        return { first, second } as T;
      },
    };
    const app = createVoydVxAppRuntime({
      host,
      initialModel: undefined,
      viewReceivesModel: false,
    });

    await expect(app.render()).resolves.toEqual({ first: 0, second: 0 });
    expect(slots[0]).not.toBe(slots[1]);

    callComponent("Component::state_set", slots[1], 1);

    await expect(app.render()).resolves.toEqual({ first: 0, second: 1 });
  });

  it("keeps keyed component state with items after reorder", async () => {
    let handlers: Record<string, (continuation: any, ...args: any[]) => unknown> = {};
    let order = ["a", "b"];
    const secondSlotsByKey = new Map<string, number>();
    const callComponent = (name: string, ...args: unknown[]) =>
      handlers[name]?.({ tail: (value?: unknown) => value }, ...args);
    const withStateScope = <T>(key: unknown, body: () => T): T =>
      handlers["Component::state_scope"]?.({ tail: body }, key) as T;
    const host: VoydVxAppHost = {
      registerHandlersByLabelSuffix: (nextHandlers) => {
        handlers = nextHandlers;
      },
      run: async <T = unknown>(entryName: string): Promise<T> => {
        if (entryName !== "view") {
          throw new Error(`unexpected fake entry ${entryName}`);
        }
        const children = order.map((key) => withStateScope(key, () => {
          const firstSlot = Number(callComponent("Component::state_key", 4321));
          const first = callComponent("Component::state_get", firstSlot, 0);
          const secondSlot = Number(callComponent("Component::state_key", 9876));
          const second = callComponent("Component::state_get", secondSlot, 0);
          secondSlotsByKey.set(key, secondSlot);
          return {
            kind: "element",
            tag: "div",
            key,
            children: [
              { kind: "text", key: `${key}-label`, value: `${key}:${String(first)}/${String(second)}` },
            ],
          };
        }));
        return { version: 1, root: { kind: "fragment", children } } as T;
      },
    };
    const app = createVoydVxAppRuntime({
      host,
      initialModel: undefined,
      viewReceivesModel: false,
    });

    await expect(app.render()).resolves.toEqual(frameWithChildren(["a:0/0", "b:0/0"]));
    callComponent("Component::state_set", secondSlotsByKey.get("b"), 1);
    order = ["b", "a"];

    await expect(app.render()).resolves.toEqual(frameWithChildren(["b:0/1", "a:0/0"]));

    order = ["x", "a", "b"];

    await expect(app.render()).resolves.toEqual(
      frameWithChildren(["x:0/0", "a:0/0", "b:0/1"]),
    );
  });

  it("scopes duplicate child keys by keyed ancestors for component state", async () => {
    let handlers: Record<string, (continuation: any, ...args: any[]) => unknown> = {};
    const slotsByScope = new Map<string, number>();
    const callComponent = (name: string, ...args: unknown[]) =>
      handlers[name]?.({ tail: (value?: unknown) => value }, ...args);
    const withStateScope = <T>(key: unknown, body: () => T): T =>
      handlers["Component::state_scope"]?.({ tail: body }, key) as T;
    const host: VoydVxAppHost = {
      registerHandlersByLabelSuffix: (nextHandlers) => {
        handlers = nextHandlers;
      },
      run: async <T = unknown>(entryName: string): Promise<T> => {
        if (entryName !== "view") {
          throw new Error(`unexpected fake entry ${entryName}`);
        }
        const children = ["left", "right"].map((scope) => withStateScope(scope, () => withStateScope("1", () => {
          const slot = Number(callComponent("Component::state_key", 2468));
          slotsByScope.set(scope, slot);
          const value = callComponent("Component::state_get", slot, 0);
          return {
            kind: "element",
            tag: "section",
            key: scope,
            children: [
              {
                kind: "element",
                tag: "button",
                key: "1",
                children: [{ kind: "text", value: `${scope}:${String(value)}` }],
              },
            ],
          };
        })));
        return { version: 1, root: { kind: "fragment", children } } as T;
      },
    };
    const app = createVoydVxAppRuntime({
      host,
      initialModel: undefined,
      viewReceivesModel: false,
    });

    await expect(app.render()).resolves.toEqual(frameWithScopedChildren(["left:0", "right:0"]));
    callComponent("Component::state_set", slotsByScope.get("right"), 1);

    await expect(app.render()).resolves.toEqual(frameWithScopedChildren(["left:0", "right:1"]));
  });

  it("does not assign parent component state to child row keys", async () => {
    let handlers: Record<string, (continuation: any, ...args: any[]) => unknown> = {};
    let order = ["a", "b"];
    let parentSlot = 0;
    const callComponent = (name: string, ...args: unknown[]) =>
      handlers[name]?.({ tail: (value?: unknown) => value }, ...args);
    const host: VoydVxAppHost = {
      registerHandlersByLabelSuffix: (nextHandlers) => {
        handlers = nextHandlers;
      },
      run: async <T = unknown>(entryName: string): Promise<T> => {
        if (entryName !== "view") {
          throw new Error(`unexpected fake entry ${entryName}`);
        }
        parentSlot = Number(callComponent("Component::state_key", 1357));
        const parentValue = callComponent("Component::state_get", parentSlot, 0);
        return {
          version: 1,
          root: {
            kind: "element",
            tag: "section",
            children: [
              { kind: "text", value: `parent:${String(parentValue)}` },
              ...order.map((key) => ({ kind: "text", key, value: key })),
            ],
          },
        } as T;
      },
    };
    const app = createVoydVxAppRuntime({
      host,
      initialModel: undefined,
      viewReceivesModel: false,
    });

    await expect(app.render()).resolves.toEqual(frameWithParentState("parent:0", ["a", "b"]));
    callComponent("Component::state_set", parentSlot, 1);
    order = ["x", "b", "a"];

    await expect(app.render()).resolves.toEqual(
      frameWithParentState("parent:1", ["x", "b", "a"]),
    );
  });
});

type FakeRun = (args: unknown[]) => Promise<unknown>;

function fakeHost(entries: Record<string, FakeRun>): VoydVxAppHost {
  return {
    run: (entryName, args = []) => {
      const entry = entries[entryName];
      if (!entry) throw new Error(`missing fake entry ${entryName}`);
      return entry(args) as Promise<never>;
    },
  };
}

function textFrame(value: string) {
  return {
    version: 1,
    root: { kind: "text", value },
  };
}

function frameWithChildren(values: string[]) {
  return {
    version: 1,
    root: {
      kind: "fragment",
      children: values.map((value) => {
        const key = value.split(":")[0] ?? value;
        return {
          kind: "element",
          tag: "div",
          key,
          children: [{ kind: "text", key: `${key}-label`, value }],
        };
      }),
    },
  };
}

function frameWithScopedChildren(values: string[]) {
  return {
    version: 1,
    root: {
      kind: "fragment",
      children: values.map((value) => {
        const scope = value.split(":")[0] ?? value;
        return {
          kind: "element",
          tag: "section",
          key: scope,
          children: [
            {
              kind: "element",
              tag: "button",
              key: "1",
              children: [{ kind: "text", value }],
            },
          ],
        };
      }),
    },
  };
}

function frameWithParentState(parent: string, keys: string[]) {
  return {
    version: 1,
    root: {
      kind: "element",
      tag: "section",
      children: [
        { kind: "text", value: parent },
        ...keys.map((key) => ({ kind: "text", key, value: key })),
      ],
    },
  };
}
