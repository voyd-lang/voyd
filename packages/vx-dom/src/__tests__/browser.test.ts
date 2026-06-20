// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVxDomRenderer, hydrateVxApp, mountVxApp } from "../browser.js";
import type {
  NormalizedEventPayload,
  VNode,
  VxAppRuntime,
  VxElementNode,
  VxRenderFrame,
  VxSubscriptionSyncContext,
  VxSubscriptionRunner,
} from "../types.js";

describe("vx-dom browser renderer", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("patches text and props without replacing the element", () => {
    const renderer = createVxDomRenderer(container);

    renderer.render(frame(inputNode({ value: "Draft", disabled: true })));
    const input = container.querySelector("input")!;

    expect(input.value).toBe("Draft");
    expect(input.disabled).toBe(true);

    renderer.render(frame(inputNode({ value: "Saved" })));

    expect(container.querySelector("input")).toBe(input);
    expect(input.value).toBe("Saved");
    expect(input.disabled).toBe(false);
  });

  it("reorders keyed children without recreating existing DOM nodes", () => {
    const renderer = createVxDomRenderer(container);

    renderer.render(frame(listNode(["a", "b", "c"])));
    const firstRender = Array.from(container.querySelectorAll("li"));

    renderer.render(frame(listNode(["c", "a", "b"])));
    const secondRender = Array.from(container.querySelectorAll("li"));

    expect(secondRender.map((node) => node.textContent)).toEqual(["c", "a", "b"]);
    expect(secondRender[0]).toBe(firstRender[2]);
    expect(secondRender[1]).toBe(firstRender[0]);
    expect(secondRender[2]).toBe(firstRender[1]);
  });

  it("reorders keyed single-child fragments without recreating DOM nodes", () => {
    const renderer = createVxDomRenderer(container);

    renderer.render(frame(keyedFragmentListNode(["a", "b", "c"])));
    const firstRender = Array.from(container.querySelectorAll("li"));

    renderer.render(frame(keyedFragmentListNode(["c", "a", "b"])));
    const secondRender = Array.from(container.querySelectorAll("li"));

    expect(secondRender.map((node) => node.textContent)).toEqual(["c", "a", "b"]);
    expect(secondRender[0]).toBe(firstRender[2]);
    expect(secondRender[1]).toBe(firstRender[0]);
    expect(secondRender[2]).toBe(firstRender[1]);
  });

  it("reorders keyed multi-child fragments without recreating DOM nodes", () => {
    const renderer = createVxDomRenderer(container);

    renderer.render(frame(keyedMultiFragmentListNode(["a", "b"])));
    const firstRender = Array.from(container.querySelectorAll("li"));

    renderer.render(frame(keyedMultiFragmentListNode(["b", "a"])));
    const secondRender = Array.from(container.querySelectorAll("li"));

    expect(secondRender.map((node) => node.textContent)).toEqual(["b:0", "b:1", "a:0", "a:1"]);
    expect(secondRender[0]).toBe(firstRender[2]);
    expect(secondRender[1]).toBe(firstRender[3]);
    expect(secondRender[2]).toBe(firstRender[0]);
    expect(secondRender[3]).toBe(firstRender[1]);
  });

  it("patches nested fragments under elements", () => {
    const renderer = createVxDomRenderer(container);

    renderer.render(frame(sectionWithNestedFragment("A")));
    renderer.render(frame(sectionWithNestedFragment("B")));

    expect(container.querySelector("section")?.textContent).toBe("B");
  });

  it("hydrates nested fragments under elements", () => {
    container.innerHTML = "<section>A</section>";
    const serverSection = container.querySelector("section");
    const renderer = createVxDomRenderer(container);

    renderer.hydrate(frame(sectionWithNestedFragment("B")));

    expect(container.querySelector("section")).toBe(serverSection);
    expect(container.querySelector("section")?.textContent).toBe("B");
  });

  it("dispatches normalized events and releases removed handlers", () => {
    const dispatch = vi.fn<RetainedDispatch>();
    const releaseMany = vi.fn<(ids: Iterable<number>) => void>();
    const renderer = createVxDomRenderer(container, {
      handlers: { dispatch, releaseMany },
    });

    renderer.render(frame(buttonNode(1)));
    container.querySelector("button")!.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 12,
      clientY: 24,
    }));

    expect(dispatch).toHaveBeenCalledWith(1, expect.objectContaining({
      kind: "mouse",
      client_x: 12,
      client_y: 24,
    }));

    renderer.render(frame(buttonNode(2)));
    container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(releaseMany).toHaveBeenCalledWith([1]);
    expect(dispatch).toHaveBeenLastCalledWith(2, expect.objectContaining({ kind: "mouse" }));
  });

  it("releases mapped event handler ids when mapped views are removed", () => {
    const dispatch = vi.fn<RetainedDispatch>();
    const releaseMany = vi.fn<(ids: Iterable<number>) => void>();
    const renderer = createVxDomRenderer(container, {
      handlers: { dispatch, releaseMany },
    });

    renderer.render({
      version: 1,
      root: {
        kind: "map",
        handlerId: 9,
        child: buttonNode(1),
      },
    });
    renderer.render(frame(buttonNode(2)));

    expect(releaseMany).toHaveBeenCalledWith([1, 9]);

    renderer.dispose();
    expect(releaseMany).toHaveBeenLastCalledWith(new Set([2]));
  });

  it("hydrates matching DOM, attaches listeners, and disposes cleanly", () => {
    const dispatch = vi.fn<RetainedDispatch>();
    const releaseMany = vi.fn<(ids: Iterable<number>) => void>();
    container.innerHTML = `<button class="old" title="stale" style="color: red">Server<span>extra</span></button>`;

    const renderer = createVxDomRenderer(container, {
      handlers: { dispatch, releaseMany },
    });
    const serverButton = container.querySelector("button")!;

    renderer.hydrate(frame({
      ...buttonNode(7),
      attrs: { class: "live" },
      styles: { background: "blue" },
      children: [{ kind: "text", value: "Client" }],
    }));

    const hydratedButton = container.querySelector("button")!;
    expect(hydratedButton).toBe(serverButton);
    expect(hydratedButton.className).toBe("live");
    expect(hydratedButton.hasAttribute("title")).toBe(false);
    expect(hydratedButton.style.color).toBe("");
    expect(hydratedButton.style.background).toBe("blue");
    expect(hydratedButton.children).toHaveLength(0);
    expect(hydratedButton.textContent).toBe("Client");

    hydratedButton.click();
    expect(dispatch).toHaveBeenCalledWith(7, expect.objectContaining({ kind: "mouse" }));

    renderer.dispose();
    expect(container.innerHTML).toBe("");
    expect(releaseMany).toHaveBeenLastCalledWith(new Set([7]));
  });

  it("hydrates mapped event handler ids from serialized frames", () => {
    const dispatch = vi.fn<RetainedDispatch>();
    const dispatchMessage = vi.fn();
    container.innerHTML = `<button>Save</button>`;
    const renderer = createVxDomRenderer(container, {
      handlers: { dispatch, dispatchMessage },
    });

    renderer.hydrate({
      version: 1,
      root: {
        kind: "element",
        tag: "button",
        events: [{
          kind: "event",
          event: "click",
          message: { type: "child" },
          mapHandlerIds: [9],
        }],
        children: [{ kind: "text", value: "Save" }],
      },
    });
    container.querySelector("button")!.click();

    expect(dispatchMessage).toHaveBeenCalledWith({
      kind: "map",
      handlerId: 9,
      message: { kind: "msgpack", value: { type: "child" } },
    });
  });

  it("mounts a runtime-owned app and runs message commands through dispatch", async () => {
    let count = 0;
    const dispose = vi.fn();
    const syncSubscriptions = vi.fn<(
      next: unknown,
      context: VxSubscriptionSyncContext,
    ) => void>();
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(count),
        commands: { type: "cmd", kind: "message", value: { type: "increment" } },
        subscriptions: { type: "sub", kind: "none" },
      }),
      render: () => counterNode(count),
      dispatch: (message) => {
        if (message.kind === "msgpack" && isIncrement(message.value)) count += 1;
        return {
          frame: counterNode(count),
          commands: { type: "cmd", kind: "none" },
          subscriptions: { type: "sub", kind: "none" },
        };
      },
      syncSubscriptions,
      dispose,
      getSnapshot: () => ({ count }),
    };

    const mounted = await mountVxApp({ container, app });

    expect(container.textContent).toBe("Count: 1");
    expect(syncSubscriptions).toHaveBeenCalledWith(
      { type: "sub", kind: "none" },
      expect.objectContaining({ previous: undefined }),
    );

    await mounted.dispatch({ kind: "msgpack", value: { type: "increment" } });

    expect(container.textContent).toBe("Count: 2");
    expect(mounted.getSnapshot()).toEqual({ count: 2 });

    mounted.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(container.innerHTML).toBe("");
  });

  it("routes retained DOM events into the runtime by default", async () => {
    let count = 0;
    const seenMessages: unknown[] = [];
    const app: VxAppRuntime = {
      init: () => counterButtonNode({ count, handlerId: 99 }),
      render: () => counterButtonNode({ count, handlerId: 99 }),
      dispatch: (message) => {
        seenMessages.push(message);
        if (message.kind === "event" && message.handlerId === 99) count += 1;
        return counterButtonNode({ count, handlerId: 99 });
      },
    };

    await mountVxApp({ container, app });
    container.querySelector("button")!.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      clientX: 8,
      clientY: 13,
    }));

    await nextTurn();

    expect(container.textContent).toBe("Count: 1");
    expect(seenMessages).toEqual([
      expect.objectContaining({
        kind: "event",
        handlerId: 99,
        payload: expect.objectContaining({
          kind: "mouse",
          client_x: 8,
          client_y: 13,
        }),
      }),
    ]);
  });

  it("routes static DOM event messages into the runtime by default", async () => {
    let count = 0;
    const seenMessages: unknown[] = [];
    const app: VxAppRuntime = {
      init: () => counterMessageButtonNode(count),
      render: () => counterMessageButtonNode(count),
      dispatch: (message) => {
        seenMessages.push(message);
        if (message.kind === "msgpack" && isIncrement(message.value)) count += 1;
        return counterMessageButtonNode(count);
      },
    };

    await mountVxApp({ container, app });
    container.querySelector("button")!.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
    }));

    await nextTurn();

    expect(container.textContent).toBe("Count: 1");
    expect(seenMessages).toEqual([
      { kind: "msgpack", value: { type: "increment" } },
    ]);
  });

  it("routes mapped static DOM event messages into the runtime", async () => {
    const seenMessages: unknown[] = [];
    const app: VxAppRuntime = {
      init: () => frame({
        kind: "map",
        handlerId: 9,
        child: {
          kind: "element",
          tag: "button",
          events: [{
            kind: "event",
            event: "click",
            message: { type: "child" },
          }],
          children: [{ kind: "text", value: "Child" }],
        },
      } as unknown as VNode),
      render: () => counterNode(seenMessages.length),
      dispatch: (message) => {
        seenMessages.push(message);
        return counterNode(seenMessages.length);
      },
    };

    await mountVxApp({ container, app });
    container.querySelector("button")!.click();
    await nextTurn();

    expect(seenMessages).toEqual([
      {
        kind: "map",
        handlerId: 9,
        message: { kind: "msgpack", value: { type: "child" } },
      },
    ]);
  });

  it("allows explicit handler registries to override runtime event dispatch", async () => {
    const runtimeDispatch = vi.fn<VxAppRuntime["dispatch"]>();
    const handlerDispatch = vi.fn<RetainedDispatch>();
    const app: VxAppRuntime = {
      init: () => counterButtonNode({ count: 0, handlerId: 5 }),
      render: () => counterButtonNode({ count: 0, handlerId: 5 }),
      dispatch: runtimeDispatch,
    };

    await mountVxApp({
      container,
      app,
      handlers: { dispatch: handlerDispatch },
    });

    container.querySelector("button")!.click();

    expect(handlerDispatch).toHaveBeenCalledWith(5, expect.objectContaining({ kind: "mouse" }));
    expect(runtimeDispatch).not.toHaveBeenCalled();
  });

  it("maps explicit handler override results for mapped runtime events", async () => {
    const seenMessages: unknown[] = [];
    const handlerDispatch = vi.fn<RetainedDispatch>(() => ({ type: "child" }));
    const app: VxAppRuntime = {
      init: () => frame({
        kind: "map",
        handlerId: 9,
        child: {
          kind: "element",
          tag: "button",
          events: [{ kind: "event", event: "click", handlerId: 5 }],
          children: [{ kind: "text", value: "Child" }],
        },
      } as unknown as VNode),
      render: () => counterNode(seenMessages.length),
      dispatch: (message) => {
        seenMessages.push(message);
        return counterNode(seenMessages.length);
      },
    };

    await mountVxApp({
      container,
      app,
      handlers: { dispatch: handlerDispatch },
    });
    container.querySelector("button")!.click();
    await nextTurn();

    expect(handlerDispatch).toHaveBeenCalledWith(5, expect.objectContaining({ kind: "mouse" }));
    expect(seenMessages).toEqual([
      {
        kind: "map",
        handlerId: 9,
        message: { kind: "msgpack", value: { type: "child" } },
      },
    ]);
  });

  it("normalizes input events from controlled form fields", async () => {
    const seenMessages: unknown[] = [];
    const app: VxAppRuntime = {
      init: () => frame({
        kind: "element",
        tag: "input",
        props: { value: "Draft" },
        events: [{ kind: "event", event: "input", handlerId: 14 }],
      }),
      render: () => frame({
        kind: "element",
        tag: "input",
        props: { value: "Draft" },
        events: [{ kind: "event", event: "input", handlerId: 14 }],
      }),
      dispatch: (message) => {
        seenMessages.push(message);
        return frame({
          kind: "element",
          tag: "input",
          props: { value: "Renamed" },
          events: [{ kind: "event", event: "input", handlerId: 14 }],
        });
      },
    };

    await mountVxApp({ container, app });
    const input = container.querySelector("input")!;
    input.value = "Renamed";
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
    }));
    await nextTurn();

    expect(input.value).toBe("Renamed");
    expect(seenMessages).toEqual([
      expect.objectContaining({
        kind: "event",
        handlerId: 14,
        payload: expect.objectContaining({
          kind: "input",
          value: "Renamed",
          checked: false,
          input_type: "insertText",
        }),
      }),
    ]);
  });

  it("normalizes form submit payloads and honors preventDefault", () => {
    const dispatch = vi.fn<RetainedDispatch>();
    const renderer = createVxDomRenderer(container, {
      handlers: { dispatch },
    });

    renderer.render(frame({
      kind: "element",
      tag: "form",
      events: [{
        kind: "event",
        event: "submit",
        handlerId: 30,
        options: { preventDefault: true },
      }],
      children: [
        {
          kind: "element",
          tag: "input",
          attrs: { name: "title" },
          props: { value: "Draft" },
        },
        {
          kind: "element",
          tag: "input",
          attrs: { name: "published", type: "checkbox" },
          props: { checked: true, value: "yes" },
        },
      ],
    }));

    const form = container.querySelector("form")!;
    const event = new SubmitEvent("submit", { bubbles: true, cancelable: true });
    const allowed = form.dispatchEvent(event);

    expect(allowed).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(30, expect.objectContaining({
      kind: "submit",
      form_data: {
        published: "yes",
        title: "Draft",
      },
      form_keys: ["title", "published"],
      form_values: ["Draft", "yes"],
    }));
  });

  it("runs custom command executors and dispatches completions", async () => {
    let count = 0;
    const runCommand = vi.fn(async (_command, { dispatch }) => {
      await dispatch({ kind: "debug", name: "loaded" });
    });
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(count),
        commands: { type: "cmd", kind: "load" },
      }),
      render: () => counterNode(count),
      dispatch: (message) => {
        if (message.kind === "debug" && message.name === "loaded") count += 1;
        return counterNode(count);
      },
    };

    await mountVxApp({
      container,
      app,
      runtimeHost: { commands: { load: runCommand } },
    });

    expect(runCommand).toHaveBeenCalledWith(
      { type: "cmd", kind: "load" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.textContent).toBe("Count: 1");
  });

  it("reports command diagnostics for unknown runtime command kinds", async () => {
    const onError = vi.fn();
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        commands: { type: "cmd", kind: "missing_host_handler" },
      }),
      render: () => counterNode(0),
      dispatch: () => counterNode(0),
    };

    await expect(mountVxApp({ container, app, onError })).rejects.toThrow(
      'no runtime command handler registered for "missing_host_handler"',
    );
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "commands" }),
    );
  });

  it("reports command diagnostics for malformed map and delay envelopes", async () => {
    const onError = vi.fn();
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        commands: { type: "cmd", kind: "map", handlerId: 1 },
      }),
      render: () => counterNode(0),
      dispatch: () => counterNode(0),
    };

    await expect(mountVxApp({ container, app, onError })).rejects.toThrow(
      "command map missing required child",
    );

    app.init = () => ({
      frame: counterNode(0),
      commands: { type: "cmd", kind: "delay", ms: 1 },
    });

    await expect(mountVxApp({ container, app, onError })).rejects.toThrow(
      "delay command missing value",
    );
  });

  it("reports command diagnostics through runtimeHost onError", async () => {
    const onError = vi.fn();
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        commands: { type: "cmd", kind: "delay", ms: 1 },
      }),
      render: () => counterNode(0),
      dispatch: () => counterNode(0),
    };

    await expect(mountVxApp({
      container,
      app,
      runtimeHost: { onError },
    })).rejects.toThrow("delay command missing value");
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "commands" }),
    );
  });

  it("wraps mapped command completions for the app runtime", async () => {
    const seenMessages: unknown[] = [];
    let count = 0;
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(count),
        commands: {
          type: "cmd",
          kind: "map",
          handlerId: 44,
          child: { type: "cmd", kind: "message", value: { type: "child" } },
        },
      }),
      render: () => counterNode(count),
      dispatch: (message) => {
        seenMessages.push(message);
        if (message.kind === "map" && message.handlerId === 44) count += 1;
        return counterNode(count);
      },
    };

    await mountVxApp({ container, app });

    expect(container.textContent).toBe("Count: 1");
    expect(seenMessages).toEqual([
      {
        kind: "map",
        handlerId: 44,
        message: { kind: "msgpack", value: { type: "child" } },
      },
    ]);
  });

  it("runs delay commands with the default browser runtime host", async () => {
    vi.useFakeTimers();
    let count = 0;
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(count),
        commands: {
          type: "cmd",
          kind: "delay",
          ms: 25,
          value: { type: "increment" },
        },
      }),
      render: () => counterNode(count),
      dispatch: (message) => {
        if (message.kind === "msgpack" && isIncrement(message.value)) count += 1;
        return counterNode(count);
      },
    };

    await mountVxApp({ container, app });
    expect(container.textContent).toBe("Count: 0");

    await vi.advanceTimersByTimeAsync(24);
    expect(container.textContent).toBe("Count: 0");

    await vi.advanceTimersByTimeAsync(1);
    expect(container.textContent).toBe("Count: 1");
  });

  it("runs task commands with the default browser runtime host", async () => {
    let count = 0;
    let resolveTask:
      | ((outcome: { kind: "value"; value: { type: "increment" } }) => void)
      | undefined;
    const observeTask = vi.fn(
      () =>
        new Promise<{ kind: "value"; value: { type: "increment" } }>((resolve) => {
          resolveTask = resolve;
        }),
    );
    const commands = { type: "cmd", kind: "task", taskId: 7 };
    Object.defineProperty(commands, Symbol.for("voyd.taskObserver"), {
      configurable: true,
      value: observeTask,
    });
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(count),
        commands,
      }),
      render: () => counterNode(count),
      dispatch: (message) => {
        if (message.kind === "msgpack" && isIncrement(message.value)) count += 1;
        return counterNode(count);
      },
    };

    await mountVxApp({ container, app });
    expect(container.textContent).toBe("Count: 0");
    expect(observeTask).toHaveBeenCalledWith(7);

    resolveTask?.({ kind: "value", value: { type: "increment" } });
    await nextTurn();

    expect(container.textContent).toBe("Count: 1");
  });

  it("reports asynchronous task command failures through onError", async () => {
    const onError = vi.fn();
    const observeTask = vi.fn(async () => {
      throw new Error("task observer failed");
    });
    const commands = { type: "cmd", kind: "task", taskId: 7 };
    Object.defineProperty(commands, Symbol.for("voyd.taskObserver"), {
      configurable: true,
      value: observeTask,
    });
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        commands,
      }),
      render: () => counterNode(0),
      dispatch: () => counterNode(0),
    };

    await mountVxApp({ container, app, onError });
    await nextTurn();

    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "commands" }),
    );
  });

  it("reports failed task command outcomes through onError", async () => {
    const error = new Error("task failed");
    const onError = vi.fn();
    const observeTask = vi.fn(async () => ({ kind: "failed" as const, error }));
    const commands = { type: "cmd", kind: "task", taskId: 7 };
    Object.defineProperty(commands, Symbol.for("voyd.taskObserver"), {
      configurable: true,
      value: observeTask,
    });
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        commands,
      }),
      render: () => counterNode(0),
      dispatch: () => counterNode(0),
    };

    await mountVxApp({ container, app, onError });
    await nextTurn();

    expect(onError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({ phase: "commands" }),
    );
  });

  it("settles failed DOM event dispatches after reporting through onError", async () => {
    const onError = vi.fn();
    const app: VxAppRuntime = {
      init: () => frame({
        kind: "element",
        tag: "button",
        events: [{ kind: "event", event: "click", message: { type: "fail" } }],
        children: [{ kind: "text", value: "Fail" }],
      }),
      render: () => counterNode(0),
      dispatch: () => {
        throw new Error("event step failed");
      },
    };

    await mountVxApp({ container, app, onError });
    container.querySelector("button")!.click();
    await nextTurn();

    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "dispatch" }),
    );
  });

  it("settles failed delayed command dispatches after reporting through onError", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        commands: {
          type: "cmd",
          kind: "delay",
          ms: 10,
          value: { type: "fail" },
        },
      }),
      render: () => counterNode(0),
      dispatch: () => {
        throw new Error("delay step failed");
      },
    };

    await mountVxApp({ container, app, onError });
    await vi.advanceTimersByTimeAsync(10);

    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "dispatch" }),
    );
  });

  it("runs ref DOM commands with the default browser runtime host", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => undefined);
    const scrollIntoView = vi.fn();
    const previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;

    try {
      const app: VxAppRuntime = {
        init: () => ({
          frame: frame({
            kind: "element",
            tag: "input",
            attrs: { "data-vx-ref": "editor" },
            props: { value: "Draft" },
          }),
          commands: {
            type: "cmd",
            kind: "batch",
            children: [
              { type: "cmd", kind: "focus", value: "editor" },
              { type: "cmd", kind: "scroll_into_view", value: "editor" },
            ],
          },
        }),
        render: () => frame({
          kind: "element",
          tag: "input",
          attrs: { "data-vx-ref": "editor" },
          props: { value: "Draft" },
        }),
        dispatch: () => frame({ kind: "text", value: "" }),
      };

      await mountVxApp({ container, app });

      expect(focus).toHaveBeenCalledOnce();
      expect(scrollIntoView).toHaveBeenCalledOnce();
    } finally {
      HTMLElement.prototype.scrollIntoView = previousScrollIntoView;
    }
  });

  it("reports diagnostics for malformed ref DOM commands", async () => {
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        commands: { type: "cmd", kind: "focus" },
      }),
      render: () => counterNode(0),
      dispatch: () => counterNode(0),
    };

    await expect(mountVxApp({ container, app })).rejects.toThrow(
      "focus command missing string value",
    );

    app.init = () => ({
      frame: counterNode(0),
      commands: { type: "cmd", kind: "scroll_into_view" },
    });

    await expect(mountVxApp({ container, app })).rejects.toThrow(
      "scroll_into_view command missing string value",
    );
  });

  it("diffs custom subscriptions and disposes removed runners", async () => {
    let count = 0;
    let subscribed = true;
    let tick: (() => Promise<void>) | undefined;
    const dispose = vi.fn();
    const runSubscription = vi.fn((_subscription, { dispatch }) => {
      tick = () => dispatch({ kind: "debug", name: "tick" });
      return dispose;
    });
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(count),
        subscriptions: { type: "sub", kind: "timer", key: "main" },
      }),
      render: () => counterNode(count),
      dispatch: (message) => {
        if (message.kind === "debug" && message.name === "tick") count += 1;
        if (message.kind === "debug" && message.name === "stop") subscribed = false;
        return {
          frame: counterNode(count),
          subscriptions: subscribed
            ? { type: "sub", kind: "timer", key: "main" }
            : { type: "sub", kind: "none" },
        };
      },
    };

    const mounted = await mountVxApp({
      container,
      app,
      runtimeHost: { subscriptions: { timer: runSubscription } },
    });

    expect(runSubscription).toHaveBeenCalledOnce();

    await tick?.();
    expect(container.textContent).toBe("Count: 1");
    expect(runSubscription).toHaveBeenCalledOnce();

    await mounted.dispatch({ kind: "debug", name: "stop" });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("replaces same-key subscriptions when descriptors change", async () => {
    let interval = 10;
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const runSubscription = vi.fn()
      .mockReturnValueOnce(firstDispose)
      .mockReturnValueOnce(secondDispose);
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        subscriptions: { type: "sub", kind: "timer", key: "main", ms: interval },
      }),
      render: () => counterNode(interval),
      dispatch: () => {
        interval = 20;
        return {
          frame: counterNode(interval),
          subscriptions: { type: "sub", kind: "timer", key: "main", ms: interval },
        };
      },
    };

    const mounted = await mountVxApp({
      container,
      app,
      runtimeHost: { subscriptions: { timer: runSubscription } },
    });

    await mounted.dispatch({ kind: "debug", name: "change" });

    expect(firstDispose).toHaveBeenCalledOnce();
    expect(runSubscription).toHaveBeenCalledTimes(2);

    mounted.dispose();
    await nextTurn();
    expect(secondDispose).toHaveBeenCalledOnce();
  });

  it("reports subscription diagnostics for malformed envelopes", async () => {
    const onError = vi.fn();
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        subscriptions: { type: "sub", kind: "timer" },
      }),
      render: () => counterNode(0),
      dispatch: () => counterNode(0),
    };

    await expect(mountVxApp({
      container,
      app,
      runtimeHost: { subscriptions: { timer: () => undefined } },
      onError,
    })).rejects.toThrow('subscription "timer" requires a stable key');
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "subscriptions" }),
    );
  });

  it("reports subscription diagnostics for malformed map envelopes", async () => {
    const onError = vi.fn();
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        subscriptions: { type: "sub", kind: "map", handlerId: 1 },
      }),
      render: () => counterNode(0),
      dispatch: () => counterNode(0),
    };

    await expect(mountVxApp({ container, app, onError })).rejects.toThrow(
      "subscription map missing required child",
    );
  });

  it("reports subscription diagnostics for malformed keyboard envelopes", async () => {
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        subscriptions: { type: "sub", kind: "keyboard", key: "Escape" },
      }),
      render: () => counterNode(0),
      dispatch: () => counterNode(0),
    };

    await expect(mountVxApp({ container, app })).rejects.toThrow(
      "keyboard subscription missing value",
    );
  });

  it("wraps nested mapped subscription completions and keeps mapped keys distinct", async () => {
    const seenMessages: unknown[] = [];
    let subscribed = true;
    const dispose = vi.fn();
    const runSubscription = vi.fn<VxSubscriptionRunner>((subscription, _context) => {
      void subscription;
      return dispose;
    });
    const mappedSubscription = {
      type: "sub",
      kind: "map",
      handlerId: 45,
      child: {
        type: "sub",
        kind: "map",
        handlerId: 46,
        child: { type: "sub", kind: "timer", key: "shared" },
      },
    };
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        subscriptions: [
          { type: "sub", kind: "timer", key: "shared" },
          mappedSubscription,
        ],
      }),
      render: () => counterNode(seenMessages.length),
      dispatch: (message) => {
        seenMessages.push(message);
        if (message.kind === "debug" && message.name === "stop") subscribed = false;
        return {
          frame: counterNode(seenMessages.length),
          subscriptions: subscribed
            ? [
              { type: "sub", kind: "timer", key: "shared" },
              mappedSubscription,
            ]
            : { type: "sub", kind: "none" },
        };
      },
    };

    const mounted = await mountVxApp({
      container,
      app,
      runtimeHost: { subscriptions: { timer: runSubscription } },
    });

    expect(runSubscription).toHaveBeenCalledTimes(2);

    const unmappedDispatch = runSubscription.mock.calls[0]?.[1].dispatch;
    const mappedDispatch = runSubscription.mock.calls[1]?.[1].dispatch;
    await unmappedDispatch?.({ kind: "debug", name: "shared" });
    expect(seenMessages[0]).toEqual({ kind: "debug", name: "shared" });

    await mappedDispatch?.({ kind: "debug", name: "mapped" });
    expect(seenMessages[1]).toEqual({
      kind: "map",
      handlerId: 45,
      message: {
        kind: "map",
        handlerId: 46,
        message: { kind: "debug", name: "mapped" },
      },
    });

    await mounted.dispatch({ kind: "debug", name: "stop" });
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("runs interval subscriptions with the default browser runtime host", async () => {
    vi.useFakeTimers();
    let count = 0;
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(count),
        subscriptions: {
          type: "sub",
          kind: "interval",
          key: "counter",
          ms: 10,
          value: { type: "increment" },
        },
      }),
      render: () => counterNode(count),
      dispatch: (message) => {
        if (message.kind === "msgpack" && isIncrement(message.value)) count += 1;
        return {
          frame: counterNode(count),
          subscriptions: {
            type: "sub",
            kind: "interval",
            key: "counter",
            ms: 10,
            value: { type: "increment" },
          },
        };
      },
    };

    const mounted = await mountVxApp({ container, app });

    await vi.advanceTimersByTimeAsync(10);
    expect(container.textContent).toBe("Count: 1");

    await vi.advanceTimersByTimeAsync(10);
    expect(container.textContent).toBe("Count: 2");

    mounted.dispose();
    await vi.advanceTimersByTimeAsync(10);
    expect(container.textContent).toBe("");
  });

  it("diffs and runs BigInt interval subscriptions from compiled frames", async () => {
    vi.useFakeTimers();
    let count = 0;
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(count),
        subscriptions: {
          type: "sub",
          kind: "interval",
          key: "counter",
          ms: 10n,
          value: { type: "increment" },
        },
      }),
      render: () => counterNode(count),
      dispatch: (message) => {
        if (message.kind === "msgpack" && isIncrement(message.value)) count += 1;
        return {
          frame: counterNode(count),
          subscriptions: {
            type: "sub",
            kind: "interval",
            key: "counter",
            ms: 10n,
            value: { type: "increment" },
          },
        };
      },
    };

    await mountVxApp({ container, app });
    await vi.advanceTimersByTimeAsync(10);

    expect(container.textContent).toBe("Count: 1");
  });

  it("runs keyboard subscriptions with the default browser runtime host", async () => {
    const seenMessages: unknown[] = [];
    const app: VxAppRuntime = {
      init: () => ({
        frame: counterNode(0),
        subscriptions: {
          type: "sub",
          kind: "keyboard",
          key: "s",
          event: "keydown",
          value: { type: "global-key" },
        },
      }),
      render: () => counterNode(0),
      dispatch: (message) => {
        seenMessages.push(message);
        return counterNode(seenMessages.length);
      },
    };

    const mounted = await mountVxApp({ container, app });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTurn();
    expect(container.textContent).toBe("Count: 0");

    window.dispatchEvent(new KeyboardEvent("keydown", {
      key: "s",
      code: "KeyS",
      ctrlKey: true,
    }));
    await nextTurn();

    expect(container.textContent).toBe("Count: 1");
    expect(seenMessages).toEqual([
      expect.objectContaining({
        kind: "subscription",
        subscriptionKind: "keyboard",
        key: "s",
        value: { type: "global-key" },
        payload: expect.objectContaining({
          kind: "keyboard",
          key: "s",
          code: "KeyS",
          ctrl_key: true,
        }),
      }),
    ]);

    mounted.dispose();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
    await nextTurn();
    expect(seenMessages).toHaveLength(1);
  });

  it("hydrates a runtime-owned app without replacing matching server nodes", async () => {
    container.innerHTML = `<p>Count: 4</p>`;
    const serverNode = container.firstChild;
    let count = 4;
    const app: VxAppRuntime = {
      init: () => counterNode(count),
      render: () => counterNode(count),
      dispatch: () => {
        count += 1;
        return counterNode(count);
      },
    };

    const mounted = await hydrateVxApp({ container, app });

    expect(container.firstChild).toBe(serverNode);
    expect(container.textContent).toBe("Count: 4");

    await mounted.dispatch({ kind: "debug", name: "increment" });

    expect(container.firstChild).toBe(serverNode);
    expect(container.textContent).toBe("Count: 5");
  });

  it("recovers the dispatch queue after a failed app step", async () => {
    let count = 0;
    const onError = vi.fn();
    const app: VxAppRuntime = {
      init: () => counterNode(count),
      render: () => counterNode(count),
      dispatch: (message) => {
        if (message.kind === "debug" && message.name === "fail") {
          throw new Error("step failed");
        }
        if (message.kind === "debug" && message.name === "increment") count += 1;
        return counterNode(count);
      },
    };
    const mounted = await mountVxApp({ container, app, onError });

    await expect(mounted.dispatch({ kind: "debug", name: "fail" })).rejects.toThrow("step failed");
    await mounted.dispatch({ kind: "debug", name: "increment" });

    expect(container.textContent).toBe("Count: 1");
    expect(onError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ phase: "dispatch" }),
    );
  });

  it("mounts a provided frame without requiring Wasm", async () => {
    const mounted = await mountVxApp({
      container,
      frame: counterNode(3),
    });

    expect(container.textContent).toBe("Count: 3");

    await mounted.dispatch({ kind: "debug", name: "noop" });
    expect(container.textContent).toBe("Count: 3");
  });
});

type RetainedDispatch = (
  id: number,
  payload: NormalizedEventPayload,
) => Promise<unknown> | unknown;

function frame(root: VNode): VxRenderFrame {
  return { version: 1, root };
}

function inputNode(props: Record<string, unknown>): VxElementNode {
  return {
    kind: "element",
    tag: "input",
    props,
    children: [],
  };
}

function listNode(keys: string[]): VxElementNode {
  return {
    kind: "element",
    tag: "ul",
    children: keys.map((key) => ({
      kind: "element",
      tag: "li",
      key,
      children: [{ kind: "text", value: key }],
    })),
  };
}

function keyedFragmentListNode(keys: string[]): VxElementNode {
  return {
    kind: "element",
    tag: "ul",
    children: keys.map((key) => ({
      kind: "fragment",
      key,
      children: [{
        kind: "element",
        tag: "li",
        children: [{ kind: "text", value: key }],
      }],
    })),
  };
}

function keyedMultiFragmentListNode(keys: string[]): VxElementNode {
  return {
    kind: "element",
    tag: "ul",
    children: keys.map((key) => ({
      kind: "fragment",
      key,
      children: [0, 1].map((index) => ({
        kind: "element",
        tag: "li",
        children: [{ kind: "text", value: `${key}:${index}` }],
      })),
    })),
  };
}

function sectionWithNestedFragment(value: string): VxElementNode {
  return {
    kind: "element",
    tag: "section",
    children: [
      {
        kind: "fragment",
        children: [{ kind: "text", value }],
      },
    ],
  };
}

function buttonNode(handlerId: number): VxElementNode {
  return {
    kind: "element",
    tag: "button",
    events: [{ kind: "event", event: "click", handlerId }],
    children: [{ kind: "text", value: "Save" }],
  };
}

function counterNode(value: number): VxRenderFrame {
  return frame({
    kind: "element",
    tag: "p",
    children: [{ kind: "text", value: `Count: ${value}` }],
  });
}

function counterButtonNode({
  count,
  handlerId,
}: {
  count: number;
  handlerId: number;
}): VxRenderFrame {
  return frame({
    kind: "element",
    tag: "button",
    events: [{ kind: "event", event: "click", handlerId }],
    children: [{ kind: "text", value: `Count: ${count}` }],
  });
}

function counterMessageButtonNode(count: number): VxRenderFrame {
  return frame({
    kind: "element",
    tag: "button",
    events: [{
      kind: "event",
      event: "click",
      message: { type: "increment" },
    }],
    children: [{ kind: "text", value: `Count: ${count}` }],
  });
}

function isIncrement(input: unknown): input is { type: "increment" } {
  return typeof input === "object" && input !== null && "type" in input
    && input.type === "increment";
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
