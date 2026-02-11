import { describe, expect, test } from "vitest";
import { parse } from "../../parser.js";

describe("colon clause attachment", () => {
  test("splices clause-only suites into the parent call", () => {
    const ast = parse(
      [
        "foo",
        "  x < 4:",
        "    hi()",
        "  x > 4:",
        "    hey()",
        "  else:",
        "    bye()",
        "",
      ].join("\n")
    ).toJSON();

    expect(ast).toEqual([
      "ast",
      [
        "foo",
        [":", ["<", "x", "4"], ["block", ["hi"]]],
        [":", [">", "x", "4"], ["block", ["hey"]]],
        [":", "else", ["block", ["bye"]]],
      ],
    ]);
  });

  test("attaches same-indent clauses to the previous call-like expression", () => {
    const ast = parse(
      [
        "if x < 4:",
        "  do_thing()",
        "x > 4:",
        "  do_another_thing()",
        "else:",
        "  do_other_thing()",
        "",
      ].join("\n")
    ).toJSON();

    expect(ast).toEqual([
      "ast",
      [
        "if",
        [":", ["<", "x", "4"], ["block", ["do_thing"]]],
        [":", [">", "x", "4"], ["block", ["do_another_thing"]]],
        [":", "else", ["block", ["do_other_thing"]]],
      ],
    ]);
  });

  test("supports multiline if via a clause suite", () => {
    const ast = parse(
      [
        "if",
        "  x < 4: 1",
        "  x > 4: 2",
        "  else: 3",
        "",
      ].join("\n")
    ).toJSON();

    expect(ast).toEqual([
      "ast",
      [
        "if",
        [":", ["<", "x", "4"], "1"],
        [":", [">", "x", "4"], "2"],
        [":", "else", "3"],
      ],
    ]);
  });

  test("attaches case-style while clauses to while calls", () => {
    const ast = parse(
      [
        "while x < 4:",
        "  do_work()",
        "",
      ].join("\n")
    ).toJSON();

    expect(ast).toEqual([
      "ast",
      [
        "while",
        [":", ["<", "x", "4"], ["block", ["do_work"]]],
      ],
    ]);
  });
});
