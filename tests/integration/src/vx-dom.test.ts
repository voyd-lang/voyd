// @vitest-environment happy-dom

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";
import {
  createVxDomRenderer,
  createVoydVxAppRuntime,
  mountVxApp,
  renderMsgPackNode,
  type VxAppRuntime,
} from "@voyd-lang/vx-dom";

const fixtureRoot = path.resolve(import.meta.dirname, "../fixtures");
const siteExampleRoot = path.resolve(
  import.meta.dirname,
  "../../../apps/site/examples",
);
const miniWikipediaRoot = path.resolve(
  import.meta.dirname,
  "../../../examples/mini-wikipedia",
);
const typedCounterEntryPath = path.join(fixtureRoot, "vx-typed-counter.voyd");
const asyncTaskCommandEntryPath = path.join(
  fixtureRoot,
  "vx-async-task-command.voyd",
);
const effectfulComponentEventEntryPath = path.join(
  fixtureRoot,
  "vx-effectful-component-event.voyd",
);
const explicitStateIdEntryPath = path.join(
  fixtureRoot,
  "vx-state-explicit-id-rejected.voyd",
);
const valueArrayModelEntryPath = path.join(
  fixtureRoot,
  "vx-value-array-model.voyd",
);
const typedMouseEventEntryPath = path.join(
  fixtureRoot,
  "vx-typed-mouse-event.voyd",
);
const userProgramNameEntryPath = path.join(
  fixtureRoot,
  "vx-user-program-name.voyd",
);
const runtimeBrowserEntryPath = path.join(
  fixtureRoot,
  "vx-runtime-browser.voyd",
);
const wideValueModelEntryPath = path.join(
  fixtureRoot,
  "vx-wide-value-model.voyd",
);
const markdownEntryPath = path.resolve(
  import.meta.dirname,
  "../../../examples/markdown.voyd",
);

type SuccessfulCompileResult = Extract<CompileResult, { success: true }>;

const expectCompileSuccess = (
  result: CompileResult,
): SuccessfulCompileResult => {
  if (!result.success) {
    throw new Error(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  expect(result.success).toBe(true);
  return result;
};

const fixtureCompilations = new Map<
  string,
  Promise<SuccessfulCompileResult>
>();

const compileFixture = (entryPath: string): Promise<SuccessfulCompileResult> => {
  const existing = fixtureCompilations.get(entryPath);
  if (existing) {
    return existing;
  }

  const compilation = createSdk()
    .compile({ entryPath })
    .then(expectCompileSuccess);
  fixtureCompilations.set(entryPath, compilation);
  return compilation;
};

const expectBasicSvgTree = (tree: unknown, html: string): void => {
  expect(html).toBe(
    '<svg viewBox="0 0 24 24"><path d="M1 1h2"></path></svg>',
  );

  const container = document.createElement("div");
  const renderer = renderMsgPackNode(tree, container);
  const svg = container.querySelector("svg")!;
  const path = svg.querySelector("path")!;
  expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(path.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(path.getAttribute("d")).toBe("M1 1h2");
  renderer.dispose();
};

describe("integration: compiled VX DOM rendering", () => {
  it("hydrates pkg::web output and renders SVG in default builds", async () => {
    const result = expectCompileSuccess(await createSdk().compile({
      source: `
use pkg::web::{
  append_hydration,
  document,
  hydrate_named,
  render
}
use std::array::Array
use std::msgpack::MsgPack
use std::vx::all

pub fn tree() -> MsgPack
  element(
    tag: "section",
    attrs: [class("card"), style(name: "display", value: "grid")],
    children: [
      element(
        tag: "input",
        attrs: [value("Draft"), disabled(true)],
        children: Array<MsgPack>::init()
      ),
      fragment([text("Ready")]),
      element(
        tag: "style",
        children: [text("a > b { color: red }")]
      )
    ]
  )

pub fn html() -> String
  render(tree())

pub fn svg_tree() -> MsgPack
  element(
    tag: "svg",
    attrs: [attr(name: "viewBox", value: "0 0 24 24")],
    children: [
      element(
        tag: "path",
        attrs: [attr(name: "d", value: "M1 1h2")],
        children: Array<MsgPack>::init()
      )
    ]
  )

pub fn svg_html() -> String
  render(svg_tree())

pub fn svg_integration_point_tree() -> MsgPack
  element(
    tag: "svg",
    children: [
      element(
        tag: "title",
        children: [element(tag: "div", children: [text("Title")])]
      ),
      element(
        tag: "desc",
        children: [element(tag: "span", children: [text("Description")])]
      )
    ]
  )

pub fn svg_integration_point_html() -> String
  render(svg_integration_point_tree())

pub fn invalid_svg_tag_html(tag: String) -> String
  render(element(
    tag: "svg",
    children: [element(tag: tag, children: Array<MsgPack>::init())]
  ))

pub fn invalid_svg_attr_html(name: String) -> String
  render(element(
    tag: "svg",
    attrs: [attr(name: name, value: "value")],
    children: Array<MsgPack>::init()
  ))

pub fn static_event_tree() -> MsgPack
  let ~attrs = Array<MsgPack>::init()
  let interactive = false
  if interactive:
    attrs.push(event_payload_handler<InputEvent, MsgPack>(
      name: "input",
      handler: (event: InputEvent) -> MsgPack => text(event.value)
    ))
  element(tag: "textarea", attrs: attrs, children: [text("Draft")])

pub fn invalid_void_html() -> String
  render(element(tag: "input", children: [text("not allowed")]))

pub fn uppercase_tag_html() -> String
  render(element(tag: "INPUT", children: Array<MsgPack>::init()))

pub fn uppercase_attribute_html() -> String
  render(element(
    tag: "div",
    attrs: [attr(name: "CLASS", value: "card")],
    children: Array<MsgPack>::init()
  ))

pub fn multi_document() -> String
  let view: MsgPack = <html><body><main id="one">One</main><aside id="two">Two</aside></body></html>
  let first = append_hydration<i32>(
    document(view),
    hydrate_named<i32>(
      id: "one".as_slice(),
      target: "#one".as_slice(),
      entry: "/one.js".as_slice(),
      model: 1
    )
  )
  append_hydration<bool>(
    first,
    hydrate_named<bool>(
      id: "two".as_slice(),
      target: "#two".as_slice(),
      entry: "/two.js".as_slice(),
      model: true
    )
  )
`,
    }));
    const [
      tree,
      html,
      svgTree,
      svgHtml,
      svgIntegrationPointTree,
      svgIntegrationPointHtml,
      multiDocument,
    ] = await Promise.all([
      result.run<unknown>({ entryName: "tree" }),
      result.run<string>({ entryName: "html" }),
      result.run<unknown>({ entryName: "svg_tree" }),
      result.run<string>({ entryName: "svg_html" }),
      result.run<unknown>({ entryName: "svg_integration_point_tree" }),
      result.run<string>({ entryName: "svg_integration_point_html" }),
      result.run<string>({ entryName: "multi_document" }),
    ]);
    expectBasicSvgTree(svgTree, svgHtml);
    expect(svgIntegrationPointHtml).toBe(
      "<svg><title><div>Title</div></title><desc><span>Description</span></desc></svg>",
    );
    const svgContainer = document.createElement("div");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    const titleDiv = document.createElement("div");
    titleDiv.textContent = "Title";
    title.appendChild(titleDiv);
    const desc = document.createElementNS("http://www.w3.org/2000/svg", "desc");
    const descSpan = document.createElement("span");
    descSpan.textContent = "Description";
    desc.appendChild(descSpan);
    svg.append(title, desc);
    svgContainer.appendChild(svg);
    const onSvgHydrationMismatch = vi.fn();
    createVxDomRenderer(svgContainer, {
      onHydrationMismatch: onSvgHydrationMismatch,
    }).hydrate(svgIntegrationPointTree);
    expect(titleDiv?.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(descSpan?.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(svgContainer.querySelector("title > div")).toBe(titleDiv);
    expect(svgContainer.querySelector("desc > span")).toBe(descSpan);
    expect(onSvgHydrationMismatch).not.toHaveBeenCalled();
    const clientSvgContainer = document.createElement("div");
    const svgRenderer = renderMsgPackNode(
      svgIntegrationPointTree,
      clientSvgContainer,
    );
    expect(clientSvgContainer.querySelector("title > div")?.namespaceURI).toBe(
      "http://www.w3.org/1999/xhtml",
    );
    expect(clientSvgContainer.querySelector("desc > span")?.namespaceURI).toBe(
      "http://www.w3.org/1999/xhtml",
    );
    svgRenderer.dispose();
    const container = document.createElement("div");
    container.innerHTML = html;
    const section = container.querySelector("section");
    const input = container.querySelector("input");
    const style = container.querySelector("style");
    const text = section?.lastChild;
    const onHydrationMismatch = vi.fn();

    createVxDomRenderer(container, { onHydrationMismatch }).hydrate(tree);

    expect(container.querySelector("section")).toBe(section);
    expect(container.querySelector("input")).toBe(input);
    expect(container.querySelector("style")).toBe(style);
    expect(container.querySelector("section")?.lastChild).toBe(text);
    expect(style?.textContent).toBe("a > b { color: red }");
    expect(onHydrationMismatch).not.toHaveBeenCalled();
    expect(multiDocument).toContain('data-voyd-hydration-id="one"');
    expect(multiDocument).toContain('data-voyd-hydration-id="two"');
    await expect(result.run<string>({ entryName: "invalid_void_html" })).rejects.toThrow();
    await expect(result.run<string>({ entryName: "uppercase_tag_html" })).rejects.toThrow();
    await expect(result.run<string>({ entryName: "uppercase_attribute_html" })).rejects.toThrow();
    await Promise.all(
      ["foreignobject", "lineargradient", "ForeignObject", "PATH"].map((tag) =>
        expect(result.run<string>({
          entryName: "invalid_svg_tag_html",
          args: [tag],
        })).rejects.toThrow()
      ),
    );
    await Promise.all(
      ["viewbox", "attributename", "ViewBox"].map((name) =>
        expect(result.run<string>({
          entryName: "invalid_svg_attr_html",
          args: [name],
        })).rejects.toThrow()
      ),
    );

    const host = await createVoydHost({ wasm: result.wasm, bufferSize: 256 * 1024 });
    await host.run("static_event_tree");
    expect(host.retainedCallbacks.size()).toBe(0);
  });

  it("renders a JS-backed Markdown package as an ordinary VX component", async () => {
    const result = expectCompileSuccess(
      await createSdk().compile({ entryPath: markdownEntryPath }),
    );
    const tree = await result.run<unknown>({
      entryName: "main",
    });
    const container = document.createElement("div");
    const renderer = renderMsgPackNode(tree, container);

    expect(container.querySelector("h1")?.textContent).toContain("Voyd Markdown");
    expect(container.querySelector("article")?.className).toBe("markdown-example");
    renderer.dispose();
  });

  it("rejects explicit component state ids", async () => {
    const sdk = createSdk();
    const result = await sdk.compile({ entryPath: explicitStateIdEntryPath });

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    ).toContain("call has 1 extra argument(s)");
  });

  it("renders a compiled Voyd VX tree through vx-dom in a browser-like DOM", async () => {
    const entryPath = path.join(fixtureRoot, "vx.voyd");
    const result = await compileFixture(entryPath);
    const tree = await result.run<unknown>({ entryName: "main" });

    const container = document.createElement("div");
    const renderer = renderMsgPackNode(tree, container);

    expect(container.querySelector("h2")?.textContent).toBe("Voyd + VX");
    expect(
      Array.from(container.querySelectorAll("li")).map(
        (node) => node.textContent,
      ),
    ).toEqual(["WASM speed", "Tiny runtime", "Clean syntax"]);

    renderer.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("dispatches static event messages from compiled Voyd VX nodes", async () => {
    const entryPath = path.join(fixtureRoot, "vx.voyd");
    const result = await compileFixture(entryPath);
    const tree = await result.run<unknown>({
      entryName: "event_message_button",
    });
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
    const entryPath = path.join(fixtureRoot, "vx-retained-event.voyd");
    const result = await compileFixture(entryPath);
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const tree = await host.run<{ events?: Array<{ handlerId?: number }> }>(
      "main",
    );
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
    const entryPath = path.join(fixtureRoot, "vx-retained-event.voyd");
    const result = await compileFixture(entryPath);
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const tree = await host.run<{ events?: Array<{ handlerId?: number }> }>(
      "input_echo",
    );
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
    const result = await compileFixture(typedCounterEntryPath);
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    await expect(host.run("mapped_program_result")).resolves.toMatchObject({
      kind: "program_map_message",
      child: { kind: "program_map_model" },
    });
    const app = createVoydVxAppRuntime({ host, app: "mapped_app" });

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    expect(container.querySelector("button")?.textContent).toContain(
      "Count: 1",
    );
    expect(container.querySelector("p")?.textContent).toBe("Ready");
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe(
      "Ready",
    );

    container.querySelector<HTMLButtonElement>("button")?.click();
    await nextTurn();

    expect(container.querySelector("button")?.textContent).toContain(
      "Count: 2",
    );

    const input = container.querySelector<HTMLInputElement>("input")!;
    input.value = "Typed VX";
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
    await nextTurn();

    expect(container.querySelector("p")?.textContent).toBe("Typed VX");

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("retains subscriptions from object syntax program lifecycle config", async () => {
    const result = await compileFixture(typedCounterEntryPath);
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });

    const inferred = await host.run<{ subscriptionsHandlerId?: number }>("app");
    const explicit = await host.run<{ subscriptionsHandlerId?: number }>(
      "app_explicit_config",
    );

    expect(typeof inferred.subscriptionsHandlerId).toBe("number");
    expect(typeof explicit.subscriptionsHandlerId).toBe("number");
  });

  it("dispatches typed task command results from a mounted Voyd app", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ entryPath: asyncTaskCommandEntryPath }),
    );
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const app = createVoydVxAppRuntime({ host });

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    expect(container.querySelector("button")?.textContent).toBe("Idle");

    container.querySelector<HTMLButtonElement>("button")?.click();
    await waitForTextContaining(container, "button", "Saved: 41");

    expect(container.querySelector("button")?.textContent).toBe("Saved: 41");

    container
      .querySelector<HTMLButtonElement>('[data-testid="ignored-result"]')
      ?.click();
    await waitForTextContaining(container, "button", "Saved: 42");

    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="typed-result"]')
        ?.textContent,
    ).toBe("Saved: 42");

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("runs the mini-wikipedia browser edit, save, and reload flow", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        entryPath: path.join(miniWikipediaRoot, "src/client.voyd"),
        roots: {
          src: path.join(miniWikipediaRoot, "src"),
          pkgDirs: [path.resolve(import.meta.dirname, "../../../packages")],
        },
      }),
    );
    const savedBodies = new Map([["home", "# Mini Voydpedia\n\nSaved body."]]);
    let saveStatus = 200;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const request = normalizeFetchRequest(input, init);
        if (request.method === "PUT" && request.url.endsWith("/api/articles")) {
          if (saveStatus >= 200 && saveStatus < 300) {
            const article = JSON.parse(request.body) as {
              slug: string;
              body: string;
            };
            savedBodies.set(article.slug, article.body);
          }
          return new Response(
            saveStatus >= 200 && saveStatus < 300 ? "saved" : "failed",
            {
              status: saveStatus,
            },
          );
        }
        return new Response("not found", { status: 404 });
      });
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 1024 * 1024,
      defaultAdapters: { runtime: "browser" },
    });

    try {
      const firstContainer = document.createElement("div");
      const firstMounted = await mountVxApp({
        container: firstContainer,
        app: createVoydVxAppRuntime({
          host,
          initialModel: miniWikipediaModel(savedBodies.get("home")!),
        }),
      });

      const editedBody = "# Mini Voydpedia\n\nOne two three";
      const textarea = firstContainer.querySelector<HTMLTextAreaElement>(
        "textarea.body-input",
      )!;
      textarea.value = editedBody;
      textarea.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText" }),
      );
      await nextTurn();

      expect(firstContainer.textContent).toContain("Unsaved changes");

      firstContainer
        .querySelector<HTMLButtonElement>('button[data-testid="save-article"]')
        ?.click();

      await waitForTextContaining(firstContainer, "main", "Saving…");
      expect(
        firstContainer.querySelector<HTMLButtonElement>(
          'button[data-testid="save-article"]',
        )?.disabled,
      ).toBe(true);

      await waitForTextContaining(firstContainer, "main", "Article saved");
      expect(savedBodies.get("home")).toBe(editedBody);

      saveStatus = 500;
      firstContainer
        .querySelector<HTMLButtonElement>('button[data-testid="edit-article"]')
        ?.click();
      await nextTurn();
      const failedTextarea = firstContainer.querySelector<HTMLTextAreaElement>(
        "textarea.body-input",
      )!;
      const failedBody = "# Mini Voydpedia\n\nThis will not save";
      failedTextarea.value = failedBody;
      failedTextarea.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText" }),
      );
      await waitForTextContaining(firstContainer, "main", "Unsaved changes");

      firstContainer
        .querySelector<HTMLButtonElement>('button[data-testid="save-article"]')
        ?.click();
      await waitForTextContaining(
        firstContainer,
        "main",
        "Could not save the article",
      );

      expect(savedBodies.get("home")).toBe(editedBody);

      firstMounted.dispose();

      const reloadedContainer = document.createElement("div");
      const reloadedMounted = await mountVxApp({
        container: reloadedContainer,
        app: createVoydVxAppRuntime({
          host,
          initialModel: miniWikipediaModel(savedBodies.get("home")!),
        }),
      });

      expect(
        reloadedContainer.querySelector<HTMLTextAreaElement>(
          "textarea.body-input",
        )?.value,
      ).toBe(editedBody);
      expect(reloadedContainer.textContent).toContain("Editing");

      reloadedMounted.dispose();
      expect(firstContainer.innerHTML).toBe("");
      expect(reloadedContainer.innerHTML).toBe("");
    } finally {
      fetchSpy.mockRestore();
    }
  }, 120_000);

  it("marshals wide value models through typed VX export wrappers", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ entryPath: wideValueModelEntryPath }),
    );
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

  it("marshals value arrays through typed VX export wrappers", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ entryPath: valueArrayModelEntryPath }),
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
    expect(container.querySelector("button")?.textContent).toContain(
      "Point: 1",
    );

    container.querySelector<HTMLButtonElement>("button")?.click();
    await nextTurn();

    expect(mounted.getSnapshot()).toEqual([
      { x: 11, y: 22 },
      { x: 13, y: 24 },
    ]);
    expect(container.querySelector("button")?.textContent).toContain(
      "Point: 11",
    );

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

    expect(container.querySelector("button")?.textContent).toContain(
      "Count: 0",
    );

    container.querySelector<HTMLButtonElement>("button")?.click();
    await waitForTextContaining(container, "button", "Count: 1");

    expect(container.querySelector("button")?.textContent).toContain(
      "Count: 1",
    );

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("marshals typed mouse payload callbacks and integer JS numbers to f64 fields", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ entryPath: typedMouseEventEntryPath }),
    );
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const app = createVoydVxAppRuntime({ host });

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    expect(container.querySelector("button")?.textContent).toContain("X: 0");

    container
      .querySelector<HTMLButtonElement>("button")
      ?.dispatchEvent(
        new MouseEvent("mousemove", { bubbles: true, clientX: 10 }),
      );
    await nextTurn();

    expect(container.querySelector("button")?.textContent).toContain("X: 10");

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("runs compiled browser runtime commands and payload subscriptions", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ entryPath: runtimeBrowserEntryPath }),
    );
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const commands = await host.run<{ children?: unknown[] }>(
      "standard_commands",
    );
    const subscriptions = await host.run<{ children?: unknown[] }>(
      "standard_subscriptions",
    );

    expect(commands.children).toHaveLength(21);
    expect(subscriptions.children).toHaveLength(14);

    const app = createVoydVxAppRuntime({ host });

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    expect(writeText).toHaveBeenCalledWith("Copied from Voyd");
    expect(container.querySelector(".status")?.textContent).toBe("ready");

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        code: "KeyS",
        ctrlKey: true,
      }),
    );
    await nextTurn();

    expect(container.querySelector(".status")?.textContent).toBe("key");
    expect(container.querySelector(".key")?.textContent).toBe("s");
    expect(container.querySelector(".code")?.textContent).toBe("KeyS");
    expect(container.querySelector(".ctrl")?.textContent).toBe("ctrl");

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("marshals typed message variants with omitted optional fields", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({
        source: `
use std::enums::{ enum }
use std::optional::types::{ Optional, Some, None }
use std::string::type::String
use std::vx::all

obj Model { count: i32 }

enum Msg
  Save { value?: String }

pub fn app() -> Program<Model, Msg>
  program({ init, step, view })

fn init() -> Model
  Model { count: 0 }

fn step(model: Model, msg: Msg) -> Program<Model, Msg>
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
      }),
    );
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const app = createVoydVxAppRuntime({ host });

    const container = document.createElement("div");
    const mounted = await mountVxApp({ container, app });

    expect(container.querySelector("button")?.textContent).toContain(
      "Count: 0",
    );

    container.querySelector<HTMLButtonElement>("button")?.click();
    await nextTurn();

    expect(container.querySelector("button")?.textContent).toContain(
      "Count: 1",
    );

    mounted.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("does not apply std::vx ABI shortcuts to user types with VX-like names", async () => {
    const sdk = createSdk();
    const result = expectCompileSuccess(
      await sdk.compile({ entryPath: userProgramNameEntryPath }),
    );

    await expect(result.run<number>({ entryName: "main" })).resolves.toBe(42);
  });

  it("renders the site wiki example from compiled Voyd source", async () => {
    const entryPath = path.join(siteExampleRoot, "wiki/wiki.voyd");
    const result = await compileFixture(entryPath);
    const tree = await result.run<unknown>({ entryName: "main" });

    const container = document.createElement("div");
    const renderer = renderMsgPackNode(tree, container);

    expect(container.querySelector(".wiki-demo-shell")).not.toBeNull();
    expect(container.querySelector(".wiki-demo-status")?.textContent).toBe(
      "Ready",
    );
    expect(
      container.querySelector(".wiki-demo-page-list .is-selected")?.textContent,
    ).toBe("Getting started");

    renderer.dispose();
    expect(container.innerHTML).toBe("");
  });

  it("mounts the site wiki example with a Voyd-owned step loop", async () => {
    const entryPath = path.join(siteExampleRoot, "wiki/wiki.voyd");
    const result = await compileFixture(entryPath);
    const host = await createVoydHost({
      wasm: result.wasm,
      bufferSize: 256 * 1024,
    });
    const app = createVoydVxAppRuntime({ host });
    const componentStateApp = createVoydVxAppRuntime({
      host,
      exports: {
        init: "component_state_init",
        step: "component_state_step",
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

    expect(
      container.querySelector(".wiki-demo-component-state")?.textContent,
    ).toContain("Local clicks: 0");
    container
      .querySelector<HTMLButtonElement>(".wiki-demo-component-state button")
      ?.click();
    await waitForTextContaining(
      container,
      ".wiki-demo-component-state",
      "Local clicks: 1",
    );
    expect(
      container.querySelector(".wiki-demo-component-state")?.textContent,
    ).toContain("Local clicks: 1");

    expect(
      container.querySelector(".wiki-demo-page-list .is-selected")?.textContent,
    ).toBe("Getting started");

    const searchInput = container.querySelector<HTMLInputElement>(
      ".wiki-demo-search input",
    )!;
    searchInput.value = "Events";
    searchInput.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
    await waitForPageButtonLabels(container, ["Events"]);

    expect(pageButtonLabels(container)).toEqual(["Events"]);
    expect(container.querySelector(".wiki-demo-hint")?.textContent).toBe(
      "Search: Events",
    );

    searchInput.value = "";
    searchInput.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
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

    container
      .querySelector<HTMLButtonElement>(".wiki-demo-search button")
      ?.click();
    await nextTurn();

    expect(container.querySelector(".wiki-demo-status")?.textContent).toBe(
      "New page",
    );
    expect(
      container.querySelector<HTMLInputElement>(".wiki-demo-label input")
        ?.value,
    ).toBe("Untitled page");
    expect(
      container.querySelector<HTMLTextAreaElement>(".wiki-demo-label textarea")
        ?.value,
    ).toBe("");
    expect(pageButtonLabels(container)).toEqual([
      "Getting started",
      "State lives in Voyd",
      "Events",
      "Untitled page",
    ]);

    container
      .querySelector<HTMLButtonElement>('[data-page-id="state"]')
      ?.click();
    await nextTurn();

    expect(
      container.querySelector(".wiki-demo-page-list .is-selected")?.textContent,
    ).toBe("State lives in Voyd");
    expect(
      container.querySelector<HTMLInputElement>(".wiki-demo-label input")
        ?.value,
    ).toBe("State lives in Voyd");

    const titleInput = container.querySelector<HTMLInputElement>(
      ".wiki-demo-label input",
    )!;
    titleInput.value = "State lives in VX";
    titleInput.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
    await nextTurn();

    expect(container.querySelector(".wiki-demo-status")?.textContent).toBe(
      "Unsaved changes",
    );
    expect(container.querySelector(".wiki-demo-dirty")?.textContent).toBe(
      "Unsaved",
    );

    container
      .querySelector<HTMLButtonElement>(".wiki-demo-toolbar button.primary")
      ?.click();
    await waitForText(container, ".wiki-demo-status", "Saved");

    expect(container.querySelector(".wiki-demo-status")?.textContent).toBe(
      "Saved",
    );
    expect(container.querySelector(".wiki-demo-dirty")?.textContent).toBe(
      "Saved",
    );

    titleInput.value = "Temporary title";
    titleInput.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
    await nextTurn();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await nextTurn();

    expect(container.querySelector(".wiki-demo-status")?.textContent).toBe(
      "Draft restored",
    );
    expect(titleInput.value).toBe("State lives in VX");

    container
      .querySelector<HTMLButtonElement>(
        ".wiki-demo-toolbar button.secondary:last-child",
      )
      ?.click();
    await nextTurn();

    expect(
      container.querySelector(".wiki-demo-inspector")?.className,
    ).toContain("is-closed");

    mounted.dispose();
    mountedComponentState.dispose();
    expect(appContainer.innerHTML).toBe("");
    expect(componentStateContainer.innerHTML).toBe("");
  });
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type MiniWikipediaModel = {
  articles: Array<{
    slug: string;
    title: string;
    overview: string;
    body: string;
    related: string[];
  }>;
  current_slug: string;
  search: string;
  mode: string;
  editor: {
    slug: string;
    title: string;
    overview: string;
    body: string;
    related: string;
  };
  status: string;
  status_kind: string;
  delete_pending: boolean;
};

function miniWikipediaModel(body: string): MiniWikipediaModel {
  const article = {
    slug: "home",
    title: "Mini Voydpedia",
    overview: "A tiny editable knowledge base.",
    body,
    related: [],
  };
  return {
    articles: [article],
    current_slug: "home",
    search: "",
    mode: "edit",
    editor: { ...article, related: "" },
    status: "Editing",
    status_kind: "neutral",
    delete_pending: false,
  };
}

function normalizeFetchRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { url: string; method: string; body: string } {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const body =
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof Uint8Array
        ? new TextDecoder().decode(init.body)
        : "";
  return { url, method, body };
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
  return Array.from(
    container.querySelectorAll(".wiki-demo-page-list button"),
  ).map((button) => button.textContent ?? "");
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
