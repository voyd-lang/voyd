import { describe, test, expect } from "vitest";
import { parse } from "../parser/parser.js";

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
    <UI::Card name="Alpha" />
  </div>
`;

    const astJson = parse(text).toJSON();
    const plain = JSON.parse(JSON.stringify(astJson));

    // Collect module access calls
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

    // Look for ::(UI, Card(...)) shape inside App body
    const match = (calls as unknown[][]).find((c) => {
      if (c.length !== 3) return false;
      const left = c[1] as unknown;
      const right = c[2] as unknown;
      const leftIsUI = left === "UI";
      const leftHasUI = Array.isArray(left) && (left as unknown[]).includes("UI");
      const rightIsCardCall = Array.isArray(right) && (right as unknown[])[0] === "Card";
      return (leftIsUI || leftHasUI) && rightIsCardCall;
    });

    expect(match, "Found namespaced component call ::(UI, Card(...))").toBeTruthy();
  });
});
