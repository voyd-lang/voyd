import { describe, expect, it } from "vitest";
import { normalizeRenderFrame } from "../normalize.js";

describe("vx-dom VNode normalization", () => {
  it("accepts case-sensitive names within SVG trees", () => {
    expect(normalizeRenderFrame({
      version: 1,
      root: {
        kind: "element",
        tag: "svg",
        attrs: { viewBox: "0 0 24 24" },
        children: [{ kind: "element", tag: "linearGradient" }],
      },
    }).root).toMatchObject({
      tag: "svg",
      attrs: { viewBox: "0 0 24 24" },
      children: [{ tag: "linearGradient" }],
    });
  });

  it("normalizes legacy create_element payloads", () => {
    expect(
      normalizeRenderFrame({
        name: "button",
        attributes: { class: "primary", disabled: true },
        children: ["Save"],
      }),
    ).toEqual({
      version: 1,
      root: {
        kind: "element",
        tag: "button",
        key: undefined,
        attrs: { class: "primary", disabled: true },
        props: undefined,
        styles: undefined,
        events: undefined,
        children: [{ kind: "text", value: "Save" }],
      },
    });
  });

  it("rejects unknown render frame versions", () => {
    expect(() => normalizeRenderFrame({ version: 2, root: null })).toThrow(
      "unsupported VX render frame version 2",
    );
  });

  it("rejects malformed versioned frames with field paths", () => {
    expect(() => normalizeRenderFrame({ version: 1 })).toThrow(
      "invalid VX frame at root",
    );
    expect(() => normalizeRenderFrame({
      version: 1,
      root: { kind: "element", tag: "" },
    })).toThrow("invalid VX frame at root.tag");
    expect(() => normalizeRenderFrame({
      version: 1,
      root: { kind: "element", tag: "SCRIPT" },
    })).toThrow("invalid HTML tag name at root.tag");
    expect(() => normalizeRenderFrame({
      version: 1,
      root: {
        kind: "element",
        tag: "input",
        children: [{ kind: "text", value: "not allowed" }],
      },
    })).toThrow("void element at root cannot have children");
    expect(() => normalizeRenderFrame({
      version: 1,
      root: {
        kind: "element",
        tag: "button",
        attrs: { "bad attr": "x" },
      },
    })).toThrow("invalid HTML attribute name at root.attrs.bad attr");
    expect(() => normalizeRenderFrame({
      version: 1,
      root: {
        kind: "element",
        tag: "button",
        attrs: { className: "primary" },
      },
    })).toThrow("invalid HTML attribute name at root.attrs.className");
    expect(normalizeRenderFrame({
      version: 1,
      root: {
        kind: "element",
        tag: "div",
        props: { textContent: "unsafe" },
      },
    }).root).toMatchObject({ props: { textContent: "unsafe" } });
    expect(() => normalizeRenderFrame({
      version: 1,
      root: {
        kind: "element",
        tag: "input",
        props: { checked: 1 },
      },
    })).toThrow("invalid DOM property value at root.props.checked");
    expect(() => normalizeRenderFrame({
      version: 1,
      root: {
        kind: "element",
        tag: "div",
        styles: { color: "red; display: none" },
      },
    })).toThrow("invalid CSS property value at root.styles.color");
    expect(() => normalizeRenderFrame({
      version: 1,
      root: {
        kind: "element",
        tag: "button",
        events: [{ kind: "event", event: "click" }],
      },
    })).toThrow("expected handlerId or message");
  });

  it("validates ordinary unversioned VX elements with the shared SSR rules", () => {
    expect(() => normalizeRenderFrame({
      kind: "element",
      tag: "div",
      attrs: { "bad attr": "x" },
    })).toThrow("invalid HTML attribute name at element.attrs.bad attr");
    expect(() => normalizeRenderFrame({
      kind: "element",
      tag: "input",
      props: { checked: 1 },
    })).toThrow("invalid DOM property value at element.props.checked");
    expect(() => normalizeRenderFrame({
      kind: "element",
      tag: "div",
      styles: { color: "red; display: none" },
    })).toThrow("invalid CSS property value at element.styles.color");
  });

  it("unwraps mapped HTML nodes for DOM rendering", () => {
    expect(
      normalizeRenderFrame({
        version: 1,
        root: {
          kind: "map",
          handlerId: 9,
          child: {
            kind: "element",
            tag: "p",
            children: [{ kind: "text", value: "Child" }],
          },
        },
      }),
    ).toMatchObject({
      version: 1,
      root: {
        kind: "element",
        tag: "p",
        children: [{ kind: "text", value: "Child" }],
      },
    });
  });

  it("preserves mapped HTML event handlers for runtime dispatch", () => {
    expect(
      normalizeRenderFrame({
        version: 1,
        root: {
          kind: "map",
          handlerId: 9,
          child: {
            kind: "element",
            tag: "button",
            events: [{ kind: "event", event: "click", message: { type: "child" } }],
          },
        },
      }),
    ).toMatchObject({
      root: {
        kind: "element",
        events: [{ event: "click", mapHandlerIds: [9] }],
      },
    });
  });

  it("normalizes MsgPack decoded Map payloads", () => {
    const frame = new Map<string, unknown>([
      ["version", 1],
      ["root", new Map<string, unknown>([
        ["kind", "element"],
        ["tag", "button"],
        ["attrs", new Map<string, unknown>([["class", "primary"]])],
        ["styles", new Map<string, unknown>([["display", "grid"]])],
        ["events", [
          new Map<string, unknown>([
            ["kind", "event"],
            ["event", "click"],
            ["handlerId", 7],
          ]),
        ]],
        ["children", [new Map<string, unknown>([
          ["kind", "text"],
          ["value", "Save"],
        ])]],
      ])],
    ]);

    expect(normalizeRenderFrame(frame)).toEqual({
      version: 1,
      root: {
        kind: "element",
        tag: "button",
        key: undefined,
        attrs: { class: "primary" },
        props: undefined,
        styles: { display: "grid" },
        events: [{ kind: "event", event: "click", handlerId: 7 }],
        children: [{ kind: "text", value: "Save", key: undefined }],
      },
    });
  });
});
