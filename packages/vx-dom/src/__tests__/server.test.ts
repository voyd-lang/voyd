import { describe, expect, it } from "vitest";
import { encode } from "@msgpack/msgpack";
import { renderVxToString } from "../server.js";

describe("vx-dom server renderer", () => {
  it("renders escaped HTML and hydration data without a DOM", async () => {
    const result = await renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "button",
          attrs: { class: "primary", disabled: true, title: `Save "draft"` },
          styles: { display: "grid" },
          events: [{ kind: "event", event: "click", handlerId: 1 }],
          children: [{ kind: "text", value: "Save <now>" }],
        },
      },
    });

    expect(result.html).toBe(
      `<button class="primary" disabled title="Save &quot;draft&quot;" style="display: grid">Save &lt;now&gt;</button>`,
    );
    expect(JSON.parse(result.hydrationData)).toMatchObject({
      version: 1,
      root: { kind: "element", tag: "button" },
    });
  });

  it("renders legacy Voyd HTML payloads", async () => {
    const result = await renderVxToString({
      tree: {
        name: "main",
        attributes: [["role", "main"]],
        children: [{ name: "h1", children: ["Wiki"] }],
      },
    });

    expect(result.html).toBe(`<main role="main"><h1>Wiki</h1></main>`);
  });

  it("rejects invalid SSR tag, attribute, and style names", async () => {
    await expect(renderVxToString({
      frame: { version: 1, root: { kind: "element", tag: "script>alert(1)</script" } },
    })).rejects.toThrow("invalid HTML tag name");

    await expect(renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "div",
          attrs: { "bad attr": "x" },
        },
      },
    })).rejects.toThrow("invalid HTML attribute name");

    await expect(renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "div",
          styles: { "color;position": "fixed" },
        },
      },
    })).rejects.toThrow("invalid CSS property name");
  });

  it("allows vendor-prefixed and custom CSS property names", async () => {
    const result = await renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "p",
          styles: {
            "-webkit-line-clamp": "2",
            "--accent-color": "red",
          },
          children: [{ kind: "text", value: "Preview" }],
        },
      },
    });

    expect(result.html).toBe(
      `<p style="-webkit-line-clamp: 2; --accent-color: red">Preview</p>`,
    );
  });


  it("renders from an existing Wasm instance export without a DOM", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const frame = {
      version: 1,
      root: {
        kind: "element",
        tag: "p",
        children: [{ kind: "text", value: "From Wasm" }],
      },
    };
    const writeFrame = () => {
      const bytes = encode(frame);
      new Uint8Array(memory.buffer).set(bytes);
      return bytes.length;
    };
    const instance = {
      exports: {
        main_memory: memory,
        render_wiki: writeFrame,
      },
    } as unknown as WebAssembly.Instance;

    const result = await renderVxToString({
      instance,
      exportName: "render_wiki",
    });

    expect(result.html).toBe(`<p>From Wasm</p>`);
    expect(JSON.parse(result.hydrationData)).toEqual(frame);
  });
});
