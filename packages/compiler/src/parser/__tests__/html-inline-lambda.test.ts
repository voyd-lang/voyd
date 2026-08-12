import { parse } from "../parser.js";
import { test } from "vitest";
import {
  type IdentifierAtom,
  type Syntax,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";

const toPlain = (code: string) =>
  JSON.parse(JSON.stringify(parse(code).toJSON())) as unknown;

const findFirstCall = (root: unknown, head: string): unknown[] | undefined => {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    if (Array.isArray(current)) {
      if (current[0] === head) {
        return current as unknown[];
      }
      current.forEach((child) => stack.push(child));
      continue;
    }

    if (current && typeof current === "object") {
      Object.values(current as Record<string, unknown>).forEach((child) =>
        stack.push(child),
      );
    }
  }
  return undefined;
};

const containsNode = (root: unknown, expected: unknown): boolean =>
  JSON.stringify(root).includes(JSON.stringify(expected));

const collectIdentifiers = (root: Syntax): IdentifierAtom[] => {
  const identifiers: IdentifierAtom[] = [];
  const visit = (syntax: Syntax): void => {
    if (isIdentifierAtom(syntax)) {
      identifiers.push(syntax);
      return;
    }
    if (isForm(syntax)) {
      syntax.toArray().forEach(visit);
    }
  };
  visit(root);
  return identifiers;
};

test("parses lambdas inside HTML interpolation expressions", (t) => {
  const code = `
use std::all
use std::vx::all
use std::msgpack::MsgPack

pub fn main() -> MsgPack
  let value: Array<String> = ["a", "b"]
  <ul>
    {value.map(f => <li style="line-height: 1.6;">{f}</li>)}
  </ul>
`;

  const ast = toPlain(code);
  const lambda = findFirstCall(ast, "=>");
  t.expect(lambda).toBeDefined();
  if (!lambda) return;
  t.expect(lambda.length).toBe(3);
  t.expect(lambda[1]).toBe("f");
});

test("lowers built-in HTML elements to HTML helpers", (t) => {
  const code = `
use std::all
use std::vx::all

pub fn main()
  <button class="primary" disabled on_click={7}>Save</button>
`;

  const ast = toPlain(code);
  t.expect(findFirstCall(ast, "html_element")).toBeDefined();
  t.expect(findFirstCall(ast, "create_element")).toBeUndefined();
  t.expect(findFirstCall(ast, "class")).toBeDefined();
  t.expect(findFirstCall(ast, "disabled")).toBeDefined();
  t.expect(findFirstCall(ast, "html_event_message")).toBeDefined();
  t.expect(findFirstCall(ast, "html_event_handler")).toBeUndefined();
});

test("lowers tag-specific value syntax to its SSR-stable representation", (t) => {
  const optionAst = toPlain(`
use std::all
use std::vx::all

pub fn main()
  <option value="voyd" selected>Voyd</option>
`);
  t.expect(findFirstCall(optionAst, "attr")).toBeDefined();
  t.expect(findFirstCall(optionAst, "value")).toBeUndefined();

  const inputAst = toPlain(`
use std::all
use std::vx::all

pub fn main()
  <input value="voyd" />
`);
  t.expect(findFirstCall(inputAst, "value")).toBeDefined();
});

test("ties generated HTML helpers to the VX compiler environment", (t) => {
  const ast = parse(`
fn Card({ value: String })
  <span>{value}</span>

fn view({ value: String, disabled: bool, checked: bool })
  <div key={value} class="field" data-label={value}>
    <input
      value={value}
      disabled={disabled}
      checked={checked}
      on_input={value}
    />
    <Card value={value} />
  </div>
`);
  const identifiers = collectIdentifiers(ast);
  const helperNames = new Set([
    "html_element",
    "html_event_message",
    "attr",
    "class",
    "value",
    "disabled",
    "checked",
    "keyed",
  ]);
  helperNames.forEach((name) => {
    const helpers = identifiers.filter(
      (identifier) =>
        identifier.value === name &&
        identifier.lexicalContext?.kind === "symbol-reference" &&
        identifier.lexicalContext.compilerOwned === true,
    );
    t.expect(helpers.length, `${name} helper`).toBeGreaterThan(0);
    helpers.forEach((helper) => {
      if (helper.lexicalContext?.kind !== "symbol-reference") return;
      t.expect(helper.lexicalContext.targetModuleId).toBe("std::vx");
    });
  });

  const component = identifiers.find(
    (identifier) => identifier.value === "Card",
  );
  t.expect(component?.lexicalContext).toBeUndefined();
  t.expect(
    identifiers.some(
      (identifier) =>
        identifier.value === "value" && identifier.lexicalContext === undefined,
    ),
  ).toBe(true);
});

test("lowers HTML key attributes to keyed nodes", (t) => {
  const code = `
use std::all
use std::vx::all

pub fn main()
  let items = ["first"]
  <ul>
    {items.map(item => <li key={item} class="row">{item}</li>)}
  </ul>
`;

  const ast = toPlain(code);
  t.expect(findFirstCall(ast, "keyed")).toBeDefined();
  t.expect(findFirstCall(ast, "class")).toBeDefined();
});

test("lowers component key attributes to keyed component nodes", (t) => {
  const code = `
use std::all
use std::vx::all

enum Msg
  Noop

fn Row({ title: String }) -> Html<Msg>
  <li>{title}</li>

pub fn main()
  let title = "first"
  <Row key={title} title={title} />
`;

  const ast = toPlain(code);
  t.expect(findFirstCall(ast, "keyed")).toBeDefined();
  t.expect(findFirstCall(ast, "Row")).toBeDefined();
});

test("lowers closure-valued HTML events to retained HTML event helpers", (t) => {
  const code = `
use std::msgpack
use std::msgpack::MsgPack
use std::vx::all

fn clicked(payload: MsgPack) -> MsgPack
  payload

pub fn main() -> MsgPack
  <button on_click={(payload: MsgPack) -> MsgPack => clicked(payload)}>Click</button>
`;

  const ast = toPlain(code);
  t.expect(findFirstCall(ast, "html_event_payload_handler")).toBeDefined();
  t.expect(findFirstCall(ast, "html_event_handler")).toBeUndefined();
  t.expect(findFirstCall(ast, "html_event_message")).toBeUndefined();
});

test("lowers non-click HTML event values to message and payload helpers", (t) => {
  const code = `
use std::msgpack
use std::msgpack::MsgPack
use std::vx::all

pub fn main() -> MsgPack
  <form on_submit={msgpack::make_string("save")}>
    <input on_input={(payload: MsgPack) -> MsgPack => payload} />
  </form>
`;

  const ast = toPlain(code);
  t.expect(findFirstCall(ast, "html_event_message")).toBeDefined();
  t.expect(findFirstCall(ast, "html_event_handler")).toBeUndefined();
  t.expect(findFirstCall(ast, "html_event_payload_handler")).toBeDefined();
});

test("lowers empty built-in HTML children to a typed HTML node array", (t) => {
  const code = `
use std::array::Array
use std::msgpack::MsgPack
use std::vx::all

pub fn main() -> MsgPack
  <form>
    <input type="text" />
    <button></button>
  </form>
`;

  const ast = parse(code);
  t.expect(
    containsNode(ast.toJSON(), [
    "::",
    ["Array", ["generics", ["Html", ["generics", "void"]]]],
    ["init"],
    ]),
  ).toBe(true);
  const identifiers = collectIdentifiers(ast);
  t.expect(
    identifiers.find(
      (identifier) =>
        identifier.value === "Array" &&
        identifier.lexicalContext?.kind === "symbol-reference" &&
        identifier.lexicalContext.targetModuleId === "std::array",
    )?.lexicalContext,
  ).toMatchObject({
    kind: "symbol-reference",
    targetModuleId: "std::array",
    compilerOwned: true,
  });
  t.expect(
    identifiers.find(
      (identifier) =>
        identifier.value === "Html" &&
        identifier.lexicalContext?.kind === "symbol-reference" &&
        identifier.lexicalContext.targetModuleId === "std::vx",
    )?.lexicalContext,
  ).toMatchObject({
    kind: "symbol-reference",
    targetModuleId: "std::vx",
    compilerOwned: true,
  });
});
