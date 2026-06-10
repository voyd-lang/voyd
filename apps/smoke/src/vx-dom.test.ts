// @vitest-environment happy-dom

import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";
import {
  createVoydVxAppRuntime,
  mountVxApp,
  renderMsgPackNode,
  type VxAppRuntime,
} from "@voyd-lang/vx-dom";

const fixtureRoot = path.resolve(import.meta.dirname, "../fixtures");
const siteExampleRoot = path.resolve(import.meta.dirname, "../../site/examples");
const typedCounterEntryPath = path.join(fixtureRoot, "vx-typed-counter.voyd");
const effectfulComponentEventEntryPath = path.join(
  fixtureRoot,
  "vx-effectful-component-event.voyd",
);
const explicitStateIdEntryPath = path.join(
  fixtureRoot,
  "vx-state-explicit-id-rejected.voyd",
);
const inlineAggregateArrayEntryPath = path.join(
  fixtureRoot,
  "vx-inline-aggregate-array.voyd",
);
const typedMouseEventEntryPath = path.join(fixtureRoot, "vx-typed-mouse-event.voyd");
const userProgramNameEntryPath = path.join(fixtureRoot, "vx-user-program-name.voyd");
const wideValueModelEntryPath = path.join(fixtureRoot, "vx-wide-value-model.voyd");

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("smoke: compiled VX DOM rendering", () => {
  it("rejects explicit component state ids", async () => {
    const sdk = createSdk();
    const result = await sdk.compile({ entryPath: explicitStateIdEntryPath });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "{ id: i32, initial: i32 }",
    );
  });

  it("renders a compiled Voyd VX tree through vx-dom in a browser-like DOM", async () => {
    const sdk = createSdk();
    const entryPath = path.join(fixtureRoot, "vx.voyd");
    const result = expectCompileSuccess(await sdk.compile({ entryPath }));
    const tree = await result.run<unknown>({ entryName: "main" });

    const container = document.createElement("div");
    const renderer = renderMsgPackNode(tree, container);

    expect(container.querySelector("h2")?.textContent).toBe("Voyd + VX");
    expect(Array.from(container.querySelectorAll("li")).map((node) => node.textContent)).toEqual([
      "WASM speed",
      "Tiny runtime",
      "Clean syntax",
    ]);

    renderer.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("dispatches static event messages from compiled Voyd VX nodes", async () => {
    const sdk = createSdk();
    const entryPath = path.join(fixtureRoot, "vx.voyd");
    const result = expectCompileSuccess(await sdk.compile({ entryPath }));
    const tree = await result.run<unknown>({ entryName: "event_message_button" });
    const seenMessages: unknown[] = [];
    const app: VxAppRuntime = {
      init: () => tree,
      render: () => tree,
      dispatch: (message) => {
        seenMessages.push(message);
        return tree;
      },
    };

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    container.querySelector("button")?.click();
    await nextTurn();

    expect(seenMessages).toEqual([{ kind: "msgpack", value: "save" }]);

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("dispatches retained Voyd event closures through the host callback registry", async () => {
    const sdk = createSdk();
    const entryPath = path.join(fixtureRoot, "vx-retained-event.voyd");
    const result = expectCompileSuccess(await sdk.compile({ entryPath }));
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const tree = await host.run<{ events?: Array<{ handlerId?: number }> }>("main");
    const handlerId = tree.events?.[0]?.handlerId;

    expect(typeof handlerId).toBe("number");
    const payload = {
      kind: "event",
      event: "click",
    };
    const message = await host.retainedCallbacks.dispatch(handlerId!, payload);

    expect(message).toEqual(payload);
  });

  it("dispatches retained Voyd input payload closures from compiled HTML events", async () => {
    const sdk = createSdk();
    const entryPath = path.join(fixtureRoot, "vx-retained-event.voyd");
    const result = expectCompileSuccess(await sdk.compile({ entryPath }));
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const tree = await host.run<{ events?: Array<{ handlerId?: number }> }>("input_echo");
    const handlerId = tree.events?.[0]?.handlerId;

    expect(typeof handlerId).toBe("number");
    const payload = {
      kind: "input",
      value: "hello",
      checked: false,
      input_type: "insertText",
    };
    const message = await host.retainedCallbacks.dispatch(handlerId!, payload);

    expect(message).toEqual(payload);
  });

  it("updates a typed VX app counter in a mounted Voyd app", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(await sdk.compile({ entryPath: typedCounterEntryPath }));
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const app = createVoydVxAppRuntime({ host });

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    expect(container.querySelector("button")?.textContent).toContain("Count: 1");
    expect(container.querySelector("p")?.textContent).toBe("Ready");
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Ready");

    container.querySelector<HTMLButtonElement>("button")?.click();
    await nextTurn();

    expect(container.querySelector("button")?.textContent).toContain("Count: 2");

    const input = container.querySelector<HTMLInputElement>("input")!;
    input.value = "Typed VX";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await nextTurn();

    expect(container.querySelector("p")?.textContent).toBe("Typed VX");

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("marshals wide value models through typed VX export wrappers", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(await sdk.compile({ entryPath: wideValueModelEntryPath }));
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const app = createVoydVxAppRuntime({ host });

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    expect(container.querySelector("button")?.textContent).toContain("Wide: 0");

    container.querySelector<HTMLButtonElement>("button")?.click();
    await nextTurn();

    expect(container.querySelector("button")?.textContent).toContain("Wide: 1");

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("marshals inline aggregate arrays through typed VX export wrappers", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ entryPath: inlineAggregateArrayEntryPath }),
    );
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const app = createVoydVxAppRuntime({ host });

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    expect(mounted.getSnapshot()).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
    expect(container.querySelector("button")?.textContent).toContain("Point: 1");

    container.querySelector<HTMLButtonElement>("button")?.click();
    await nextTurn();

    expect(mounted.getSnapshot()).toEqual([
      { x: 11, y: 22 },
      { x: 13, y: 24 },
    ]);
    expect(container.querySelector("button")?.textContent).toContain("Point: 11");

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("runs effectful component-local state updates from retained event callbacks", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ entryPath: effectfulComponentEventEntryPath }),
    );
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const app = createVoydVxAppRuntime({
      host,
      viewReceivesModel: false,
    });

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    expect(container.querySelector("button")?.textContent).toContain("Count: 0");

    container.querySelector<HTMLButtonElement>("button")?.click();
    await waitForTextContaining(container, "button", "Count: 1");

    expect(container.querySelector("button")?.textContent).toContain("Count: 1");

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("marshals typed mouse payload callbacks and integer JS numbers to f64 fields", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(await sdk.compile({ entryPath: typedMouseEventEntryPath }));
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const app = createVoydVxAppRuntime({ host });

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    expect(container.querySelector("button")?.textContent).toContain("X: 0");

    container.querySelector<HTMLButtonElement>("button")?.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 10 }),
    );
    await nextTurn();

    expect(container.querySelector("button")?.textContent).toContain("X: 10");

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("marshals typed message variants with omitted optional fields", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(await sdk.compile({
      source: `
use std::enums::{ enum }
use std::optional::types::{ Optional, Some, None }
use std::string::type::String
use std::vx::all

obj Model { count: i32 }

enum Msg
  Save { value?: String }

pub fn app() -> Program<Model, Msg>
  program<Model, Msg>(
    init: init,
    update: update,
    view: view
  )

fn init() -> Model
  Model { count: 0 }

fn update(model: Model, msg: Msg) -> Program<Model, Msg>
  match(msg)
    Msg::Save { value }:
      program<Model, Msg>(model: Model { count: model.count + optional_bonus(value) })

fn view(model: Model) -> Html<Msg>
  <button on_click={Msg::Save {}}>Count: {count_label(model.count)}</button>

fn optional_bonus(value: Optional<String>) -> i32
  match(value)
    Some<String> { value: _present }: 10
    None: 1

fn count_label(value: i32) -> String
  if
    value == 0: "0"
    value == 1: "1"
    else: "many"
`,
      entryPath: "optional-vx-message.voyd",
    }));
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const app = createVoydVxAppRuntime({ host });

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    expect(container.querySelector("button")?.textContent).toContain("Count: 0");

    container.querySelector<HTMLButtonElement>("button")?.click();
    await nextTurn();

    expect(container.querySelector("button")?.textContent).toContain("Count: 1");

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("does not apply std::vx ABI shortcuts to user types with VX-like names", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(await sdk.compile({ entryPath: userProgramNameEntryPath }));

    await expect(result.run<number>({ entryName: "main" })).resolves.toBe(42);
  });

  it("renders the site wiki example from compiled Voyd source", async () => {
    const sdk = createSdk();
    const entryPath = path.join(siteExampleRoot, "wiki/wiki.voyd");
    const result = expectCompileSuccess(await sdk.compile({ entryPath }));
    const tree = await result.run<unknown>({ entryName: "main" });

    const container = document.createElement("div");
    const renderer = renderMsgPackNode(tree, container);

    expect(container.querySelector(".wiki-demo-shell")).not.toBeNull();
    expect(container.querySelector(".wiki-demo-status")?.textContent).toBe("Ready");
    expect(container.querySelector(".wiki-demo-page-list .is-selected")?.textContent).toBe(
      "Getting started",
    );

    renderer.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("mounts the site wiki example with a Voyd-owned update loop", async () => {
    const sdk = createSdk();
    const entryPath = path.join(siteExampleRoot, "wiki/wiki.voyd");
    const result = expectCompileSuccess(await sdk.compile({ entryPath }));
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const app = createVoydVxAppRuntime({ host });
    const componentStateApp = createVoydVxAppRuntime({
      host,
      exports: {
        init: "component_state_init",
        update: "component_state_update",
        view: "component_state_view",
      },
      viewReceivesModel: false,
    });

    const container = document.createElement("div");
    const appContainer = document.createElement("div");
    const componentStateContainer = document.createElement("div");
    container.append(appContainer, componentStateContainer);

    const mounted = await mountVxApp({ container: appContainer, app });
    const mountedComponentState = await mountVxApp({
      container: componentStateContainer,
      app: componentStateApp,
    });

    expect(container.querySelector(".wiki-demo-component-state")?.textContent).toContain(
      "Local clicks: 0",
    );
    container.querySelector<HTMLButtonElement>(".wiki-demo-component-state button")?.click();
    await waitForTextContaining(
      container,
      ".wiki-demo-component-state",
      "Local clicks: 1",
    );
    expect(container.querySelector(".wiki-demo-component-state")?.textContent).toContain(
      "Local clicks: 1",
    );

    expect(container.querySelector(".wiki-demo-page-list .is-selected")?.textContent).toBe(
      "Getting started",
    );

    const searchInput = container.querySelector<HTMLInputElement>('.wiki-demo-search input')!;
    searchInput.value = "Events";
    searchInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await waitForPageButtonLabels(container, ["Events"]);

    expect(pageButtonLabels(container)).toEqual(["Events"]);
    expect(container.querySelector(".wiki-demo-hint")?.textContent).toBe("Search: Events");

    searchInput.value = "";
    searchInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    await waitForPageButtonLabels(container, [
      "Getting started",
      "State lives in Voyd",
      "Events",
    ]);

    expect(pageButtonLabels(container)).toEqual([
      "Getting started",
      "State lives in Voyd",
      "Events",
    ]);

    container.querySelector<HTMLButtonElement>(".wiki-demo-search button")?.click();
    await nextTurn();

    expect(container.querySelector(".wiki-demo-status")?.textContent).toBe("New page");
    expect(container.querySelector<HTMLInputElement>(".wiki-demo-label input")?.value).toBe(
      "Untitled page",
    );
    expect(container.querySelector<HTMLTextAreaElement>(".wiki-demo-label textarea")?.value).toBe(
      "",
    );
    expect(pageButtonLabels(container)).toEqual([
      "Getting started",
      "State lives in Voyd",
      "Events",
      "Untitled page",
    ]);

    container.querySelector<HTMLButtonElement>('[data-page-id="state"]')?.click();
    await nextTurn();

    expect(container.querySelector(".wiki-demo-page-list .is-selected")?.textContent).toBe(
      "State lives in Voyd",
    );
    expect(container.querySelector<HTMLInputElement>(".wiki-demo-label input")?.value).toBe(
      "State lives in Voyd",
    );

    const titleInput = container.querySelector<HTMLInputElement>(".wiki-demo-label input")!;
    titleInput.value = "State lives in VX";
    titleInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await nextTurn();

    expect(container.querySelector(".wiki-demo-status")?.textContent).toBe("Unsaved changes");
    expect(container.querySelector(".wiki-demo-dirty")?.textContent).toBe("Unsaved");

    container.querySelector<HTMLButtonElement>(".wiki-demo-toolbar button.primary")?.click();
    await waitForText(container, ".wiki-demo-status", "Saved");

    expect(container.querySelector(".wiki-demo-status")?.textContent).toBe("Saved");
    expect(container.querySelector(".wiki-demo-dirty")?.textContent).toBe("Saved");

    titleInput.value = "Temporary title";
    titleInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await nextTurn();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTurn();

    expect(container.querySelector(".wiki-demo-status")?.textContent).toBe("Draft restored");
    expect(titleInput.value).toBe("State lives in VX");

    container.querySelector<HTMLButtonElement>(".wiki-demo-toolbar button.secondary:last-child")?.click();
    await nextTurn();

    expect(container.querySelector(".wiki-demo-inspector")?.className).toContain("is-closed");

    mounted.dispose();
    mountedComponentState.dispose();
    expect(appContainer.innerHTML).toBe("");
    expect(componentStateContainer.innerHTML).toBe("");
  });
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForText(
  container: Element,
  selector: string,
  expected: string,
  timeoutMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (container.querySelector(selector)?.textContent === expected) {
      return;
    }
    await wait(5);
  }
}

async function waitForTextContaining(
  container: Element,
  selector: string,
  expected: string,
  timeoutMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (container.querySelector(selector)?.textContent?.includes(expected)) {
      return;
    }
    await wait(5);
  }
}

function pageButtonLabels(container: Element): string[] {
  return Array.from(container.querySelectorAll(".wiki-demo-page-list button"))
    .map((button) => button.textContent ?? "");
}

async function waitForPageButtonLabels(
  container: Element,
  expected: string[],
  timeoutMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const actual = pageButtonLabels(container);
    if (
      actual.length === expected.length &&
      actual.every((label, index) => label === expected[index])
    ) {
      return;
    }
    await wait(5);
  }
}
