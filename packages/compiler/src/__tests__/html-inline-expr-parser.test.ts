import { describe, test, expect } from "vitest";
import { parse } from "../parser/parser.js";

describe("HTML inline expressions unwrap identifiers", () => {
  test("{item} is not wrapped as a list", () => {
    const text = `
use std::all
use std::vsx::create_element
use std::msg_pack::MsgPack

pub fn component()
  let a = ["Alex", "Abby"]
  <div>
    {a.map<MsgPack>((item) -> MsgPack => <p>hi {item}</p>)}
  </div>

pub fn main()
  msg_pack::encode(component())
`;

    const astJson = parse(text).toJSON();
    // Convert to plain JSON for easier traversal
    const plain = JSON.parse(JSON.stringify(astJson));

    // Walk the JSON to collect create_element calls
    const elements: unknown[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        if (node[0] === "create_element") elements.push(node);
        node.forEach(walk);
      } else if (node && typeof node === "object") {
        Object.values(node as Record<string, unknown>).forEach(walk);
      }
    };

    walk(plain);

    // Heuristic: inner <p> is the last create_element in this snippet
    const target = elements[elements.length - 1] as unknown[] | undefined;

    expect(target, "Found <p> element with item child").toBeTruthy();
    const children = (target![3] as unknown[]).slice(1);
    expect(children).toContain("item");
    expect(children).not.toContainEqual(["item"]);

    // Snapshot just the <p> element structure to lock in behavior
    expect(target).toMatchSnapshot();
  });
});
