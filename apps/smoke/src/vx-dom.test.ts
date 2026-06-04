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
} from "@voyd-lang/vx-dom/browser";

const fixtureRoot = path.resolve(import.meta.dirname, "../fixtures");
const siteExampleRoot = path.resolve(import.meta.dirname, "../../site/examples");

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
    const app = createVoydVxAppRuntime({
      host,
      exports: { subscriptions: "subscriptions" },
    });
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
    const mounted = await mountVxApp({ container, app });
    const componentStateContainer = document.createElement("div");
    const componentStateMounted = await mountVxApp({
      container: componentStateContainer,
      app: componentStateApp,
    });

    expect(componentStateContainer.querySelector(".wiki-demo-component-state")?.textContent).toContain(
      "remembered",
    );
    componentStateContainer.querySelector<HTMLButtonElement>("button")?.click();
    await nextTurn();
    expect(componentStateContainer.querySelector(".wiki-demo-component-state")?.textContent).toContain(
      "remembered",
    );

    expect(container.querySelector(".wiki-demo-page-list .is-selected")?.textContent).toBe(
      "Getting started",
    );

    const searchInput = container.querySelector<HTMLInputElement>('.wiki-demo-search input')!;
    searchInput.value = "Events";
    searchInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await nextTurn();

    expect(pageButtonLabels(container)).toEqual(["Events"]);
    expect(container.querySelector(".wiki-demo-hint")?.textContent).toBe("Search: Events");

    searchInput.value = "";
    searchInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    await nextTurn();

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
    await wait(10);

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
    componentStateMounted.dispose();
    expect(container.innerHTML).toBe("");
    expect(componentStateContainer.innerHTML).toBe("");
  });
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pageButtonLabels(container: Element): string[] {
  return Array.from(container.querySelectorAll(".wiki-demo-page-list button"))
    .map((button) => button.textContent ?? "");
}
