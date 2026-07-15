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

  it("encodes carriage returns so HTML parsing preserves exact text and attributes", async () => {
    const result = await renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "p",
          attrs: { title: "A\r\nB" },
          children: [{ kind: "text", value: "A\r\nB" }],
        },
      },
    });

    expect(result.html).toBe(`<p title="A&#13;\nB">A&#13;\nB</p>`);
  });

  it("preserves leading newlines in parser-sensitive elements", async () => {
    const result = await renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "pre",
          children: [{ kind: "text", value: "\nLeading" }],
        },
      },
    });

    expect(result.html).toBe("<pre>\n\nLeading</pre>");
  });

  it("serializes controlled textarea values as matching text content", async () => {
    const result = await renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "textarea",
          props: { value: "Draft" },
          children: [{ kind: "text", value: "Draft" }],
        },
      },
    });

    expect(result.html).toBe("<textarea>Draft</textarea>");
  });

  it("rejects form properties without a stable SSR representation", async () => {
    await expect(renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "select",
          props: { value: "draft" },
        },
      },
    })).rejects.toThrow("property value has no stable SSR representation on <select>");

    await expect(renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "textarea",
          props: { value: "Draft" },
          children: [{ kind: "text", value: "Other" }],
        },
      },
    })).rejects.toThrow("textarea value must match its text children");
  });

  it("renders raw-text element children without entity decoding drift", async () => {
    const result = await renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "fragment",
          children: [
            {
              kind: "element",
              tag: "style",
              children: [{ kind: "text", value: "a > b { color: red }" }],
            },
            {
              kind: "element",
              tag: "script",
              children: [{ kind: "text", value: "if (a < b) value = '&'" }],
            },
          ],
        },
      },
    });

    expect(result.html).toBe(
      "<style>a > b { color: red }</style><script>if (a < b) value = '&'</script>",
    );
  });

  it("rejects raw text that can terminate its containing element", async () => {
    await expect(renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "script",
          children: [{ kind: "text", value: "</SCRIPT><p>unsafe</p>" }],
        },
      },
    })).rejects.toThrow("script text contains its closing delimiter");
  });

  it("rejects invalid SSR tag, attribute, and style names", async () => {
    await expect(renderVxToString({
      frame: { version: 1, root: { kind: "element", tag: "script>alert(1)</script" } },
    })).rejects.toThrow("invalid HTML tag name");

    await expect(renderVxToString({
      frame: { version: 1, root: { kind: "element", tag: "INPUT" } },
    })).rejects.toThrow("invalid HTML tag name");

    await expect(renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "input",
          children: [{ kind: "text", value: "not allowed" }],
        },
      },
    })).rejects.toThrow("void element at root cannot have children");

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

    await expect(renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "div",
          props: { innerHTML: "<img src=x onerror=alert(1)>" },
        },
      },
    })).rejects.toThrow("unsupported DOM property");

    await expect(renderVxToString({
      frame: {
        version: 1,
        root: {
          kind: "element",
          tag: "div",
          styles: { color: "red; display: none" },
        },
      },
    })).rejects.toThrow("invalid CSS property value");
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
