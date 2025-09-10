import { describe, test, expect } from "vitest";
import { parse } from "../parser/parser.js";
import { List, Call, ObjectLiteral } from "../syntax-objects/index.js";
import { vsxComponentsVoyd } from "./fixtures/vsx.js";

describe("HTML parser supports capitalized component calls", () => {
  test("<Card ...> becomes Card({..., children: [...]})", () => {
    const astJson = parse(vsxComponentsVoyd).toJSON();
    const plain = JSON.parse(JSON.stringify(astJson));

    const calls: unknown[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) {
        if (node[0] === "Card") calls.push(node);
        node.forEach(walk);
      } else if (node && typeof node === "object") {
        Object.values(node as Record<string, unknown>).forEach(walk);
      }
    };
    walk(plain);

    // Find the actual component call in App body (Card with object-literal props)
    const card = (calls as unknown[][]).find((c) => {
      if (!Array.isArray(c[1])) return false;
      const head = (c[1] as unknown[])[0];
      const idMaybe = (c[1] as unknown[])[1];
      return head === "object" && typeof idMaybe === "string" && idMaybe.startsWith("ObjectLiteral-");
    }) as unknown[] | undefined;
    expect(card, "Found Card call").toBeTruthy();

    // Assert first argument is an object-literal props bag
    const props = card![1] as unknown[];
    expect(Array.isArray(props)).toBe(true);
    expect(props[0]).toBe("object");

    // Props fields: expect name and children entries to exist
    const fields = (props[2] as unknown[]) as unknown[][];
    const fieldNames = new Set(fields.map((f) => (Array.isArray(f) ? f[0] : "")));
    expect(fieldNames.has("name")).toBe(true);
    expect(fieldNames.has("children")).toBe(true);
  });

  test("nested component children maintain parent chain", () => {
    const ast = parse("pub fn App() <Card><Button /></Card>");
    const fnList = ast.at(1) as List;
    const cardCall = fnList.at(3) as Call;
    const props = cardCall.args.at(0) as ObjectLiteral;
    const children = props.fields.find((f) => f.name === "children")
      ?.initializer as List;
    const buttonCall = children.at(1);
    expect(buttonCall?.parent).toBe(children);
    expect(children.parent).toBe(props);
  });
});
