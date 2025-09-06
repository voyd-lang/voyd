import { describe, test, beforeAll, expect } from "vitest";
import assert from "node:assert";
import { compile } from "../compiler.js";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import { decode } from "@msgpack/msgpack";
import { parse } from "../parser/parser.js";

// One WASM module containing multiple exported functions used by all VSX tests
const combinedSource = `
use std::all
use std::vsx::create_element
use std::msg_pack
use std::msg_pack::MsgPack

// ---- VSX fixture (was vsx.e2e.test.ts) ----
pub fn vsx_main()
  <div class=\"size-full rounded bg-black\">\n    <p class=\"prose\">\n      Hello World!\n    </p>\n    <p class=\"prose\">\n      I am M87\n    </p>\n  </div>

pub fn vsx_run() -> i32
  msg_pack::encode(vsx_main())

// ---- Self-closing component (was vsx-self-closing-component.e2e.test.ts) ----
pub fn Card({ name: String, children?: Array<MsgPack> })
  let content = if c := children then: c else: []

  <div class=\"card\">\n    <h1 class=\"card-title\">Hello {name}</h1>\n    {content}\n  </div>

pub fn App()
  <div class=\"wrap\">\n    <Card name=\"No kids\" />\n  </div>

pub fn comp_run() -> i32
  msg_pack::encode(App())

// ---- <ul> children map (was vsx-ul-map.e2e.test.ts) ----
fn component() -> Map<MsgPack>
  let a = [\"Alex\", \"Abby\"]
  <div>
    <ul>
      {a.map(item => <li>hi {item}</li>)}
    </ul>
  </div>

pub fn test_ul_map() -> i32
  msg_pack::encode(component())
`;

describe("Combined VSX e2e (single WASM instance)", () => {
  let instance: WebAssembly.Instance;
  let memory: WebAssembly.Memory;

  beforeAll(async () => {
    const mod = await compile(combinedSource);
    instance = getWasmInstance(mod);
    memory = instance.exports["main_memory"] as WebAssembly.Memory;
  });

  test("vsx main HTML compiles and encodes expected MsgPack", () => {
    const fn = getWasmFn("vsx_run", instance);
    assert(fn, "vsx_run exists");
    const index = fn();
    const decoded = decode(memory.buffer.slice(0, index));
    expect(decoded).toEqual({
      name: "div",
      attributes: { class: "size-full rounded bg-black" },
      children: [
        {
          name: "p",
          attributes: { class: "prose" },
          children: ["Hello World! "],
        },
        {
          name: "p",
          attributes: { class: "prose" },
          children: ["I am M87 "],
        },
      ],
    });
  });

  test("self-closing component compiles with no children prop passed", () => {
    const fn = getWasmFn("comp_run", instance);
    assert(fn, "comp_run exists");
    const index = fn();
    const decoded = decode(memory.buffer.slice(0, index));
    expect(decoded).toEqual({
      name: "div",
      attributes: { class: "wrap" },
      children: [
        {
          name: "div",
          attributes: { class: "card" },
          children: [
            {
              name: "h1",
              attributes: { class: "card-title" },
              children: ["Hello ", "No kids"],
            },
            [],
          ],
        },
      ],
    });
  });

  test("<ul> children map compiles and encodes expected structure", () => {
    const fn = getWasmFn("test_ul_map", instance);
    assert(fn, "test_ul_map exists");
    const index = fn();
    const decoded = decode(memory.buffer.slice(0, index));
    expect(decoded).toEqual({
      name: "div",
      attributes: {},
      children: [
        {
          name: "ul",
          attributes: {},
          children: [
            [
              { name: "li", attributes: {}, children: ["hi ", "Alex"] },
              { name: "li", attributes: {}, children: ["hi ", "Abby"] },
            ],
          ],
        },
      ],
    });
  });
});

// Keep the parser test here as well so all four original tests are combined
describe("HTML parser supports namespaced component calls", () => {
  test("<UI::Card ...> becomes ::(UI, Card({...}))", () => {
    const text = `
use std::all
use std::vsx::create_element
use std::msg_pack
use std::msg_pack::MsgPack

pub mod UI
  use std::all
  pub fn Card({ name: String, children?: Array<MsgPack> })
    0

pub fn App()
  <div>
    <UI::Card name=\"Alpha\" />
  </div>
`;

    const astJson = parse(text).toJSON();
    const plain = JSON.parse(JSON.stringify(astJson));

    const calls: unknown[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        if (node[0] === "::") calls.push(node);
        node.forEach(walk);
      } else if (node && typeof node === "object") {
        Object.values(node as Record<string, unknown>).forEach(walk);
      }
    };
    walk(plain);

    const match = (calls as unknown[][]).find((c) => {
      if (c.length !== 3) return false;
      const left = c[1] as unknown;
      const right = c[2] as unknown;
      const leftIsUI = left === "UI";
      const leftHasUI =
        Array.isArray(left) && (left as unknown[]).includes("UI");
      const rightIsCardCall =
        Array.isArray(right) && (right as unknown[])[0] === "Card";
      return (leftIsUI || leftHasUI) && rightIsCardCall;
    });

    expect(!!match, "Found namespaced component call ::(UI, Card(...))").toBe(
      true
    );
  });
});
