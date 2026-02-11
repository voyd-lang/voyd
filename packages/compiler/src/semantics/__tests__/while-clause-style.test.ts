import { describe, expect, it } from "vitest";
import { type Form, isForm, parse } from "../../parser/index.js";
import { parseWhileConditionAndBody } from "../utils.js";

const parseWhile = (source: string): Form => {
  const ast = parse(source, "while_clause_style_test.voyd");
  const whileExpr = ast.rest.find(
    (entry): entry is Form => isForm(entry) && entry.calls("while")
  );

  expect(whileExpr).toBeDefined();
  if (!whileExpr) {
    throw new Error("expected a while expression");
  }

  return whileExpr;
};

describe("parseWhileConditionAndBody", () => {
  it("supports case-style while clauses with a single while argument", () => {
    const whileExpr = parseWhile(
      [
        "while x < 4:",
        "  do_work()",
        "",
      ].join("\n")
    );
    const { condition, body } = parseWhileConditionAndBody(whileExpr);

    expect(condition.toJSON()).toEqual(["<", "x", "4"]);
    expect(body.toJSON()).toEqual(["block", ["do_work"]]);
  });

  it("keeps ':' conditions when an explicit do body is present", () => {
    const whileExpr = parseWhile(
      [
        "while lhs : rhs do:",
        "  do_work()",
        "",
      ].join("\n")
    );
    const { condition, body } = parseWhileConditionAndBody(whileExpr);

    expect(condition.toJSON()).toEqual([":", "lhs", "rhs"]);
    expect(body.toJSON()).toEqual(["block", ["do_work"]]);
  });
});
