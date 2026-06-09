import { describe, expect, it } from "vitest";
import { normalizeRenderFrame } from "../normalize.js";

describe("vx-dom VNode normalization", () => {
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
