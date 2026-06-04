import { describe, expect, it, vi } from "vitest";
import { createVoydVxAppRuntime, type VoydVxAppHost } from "../app-runtime.js";

describe("createVoydVxAppRuntime", () => {
  it("keeps model ownership in Voyd exports", async () => {
    let model = "intro";
    const host = fakeHost({
      init: async () => model,
      view: async ([current]) => textFrame(`Page: ${String(current)}`),
      update: async ([current, message]) => {
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
        model: 0,
        frame: textFrame("Boot"),
        commands: { type: "cmd", kind: "message", value: "tick" },
      }),
      view: async ([count]) => textFrame(`Count: ${String(count)}`),
      update: async ([count]) => ({
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

  it("resolves retained event and mapped runtime messages before update", async () => {
    const seenMessages: unknown[] = [];
    const retainedDispatch = vi.fn(async (id: number, payload: unknown) => ({
      id,
      payload,
    }));
    const host = fakeHost({
      init: async () => "ready",
      view: async ([current]) => textFrame(String(current)),
      update: async ([current, message]) => {
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
