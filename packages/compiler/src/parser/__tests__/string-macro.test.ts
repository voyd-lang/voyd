import { describe, expect, it } from "vitest";
import { string as stringExpr } from "../ast/init-helpers.js";
import {
  call,
  type Expr,
  Form,
  IntAtom,
  identifier,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import { CharStream } from "../char-stream.js";
import { read } from "../reader.js";

const bytesFromStringLiteral = (value: string): number[] => {
  const expr: Expr = stringExpr(value);
  if (!isForm(expr)) {
    throw new Error("string helper did not return a form");
  }

  const bytesForm = expr.at(1);
  if (!isForm(bytesForm) || !bytesForm.callsInternal("fixed_array_literal")) {
    throw new Error("string helper did not emit fixed_array_literal bytes");
  }

  const bytes: number[] = [];
  bytesForm.rest.forEach((entry) => {
    if (entry instanceof IntAtom) {
      bytes.push(Number.parseInt(entry.value, 10));
      return;
    }
    if (isIdentifierAtom(entry)) {
      bytes.push(Number.parseInt(entry.value, 10));
    }
  });

  return bytes;
};

const parseSingleExpression = (source: string): Expr => {
  const parsed = read(new CharStream(source, "test"));
  const first = parsed.at(1);
  if (!first) {
    throw new Error("expected one expression");
  }
  return first;
};

const toPlain = (expr: Expr): unknown =>
  JSON.parse(JSON.stringify(expr.toJSON())) as unknown;

const methodCall = ({
  target,
  method,
  args = [],
}: {
  target: Expr;
  method: string;
  args?: Expr[];
}): Expr => call(identifier("."), target, new Form([identifier(method), ...args]).toCall());

describe("string macro utf8 encoding", () => {
  it("encodes surrogate pairs as utf8 bytes", () => {
    expect(bytesFromStringLiteral("😀")).toEqual([240, 159, 152, 128]);
  });

  it("replaces unpaired surrogates", () => {
    const value = String.fromCharCode(0xd800);
    expect(bytesFromStringLiteral(value)).toEqual([239, 191, 189]);
  });

  it("parses interpolation into concat calls", () => {
    const expected = methodCall({
      target: stringExpr(""),
      method: "concat",
      args: [
        methodCall({
          target: stringExpr("Hello, "),
          method: "concat",
          args: [identifier("name")],
        }),
      ],
    });

    expect(toPlain(parseSingleExpression('"Hello, ${name}"'))).toEqual(
      toPlain(expected)
    );
  });

  it("keeps escaped interpolation markers as text", () => {
    expect(toPlain(parseSingleExpression('"Hello, \\${name}"'))).toEqual(
      toPlain(stringExpr("Hello, ${name}"))
    );
  });

  it("supports interpolation-only and mixed interpolation strings", () => {
    const interpolationOnly = identifier("first");
    expect(toPlain(parseSingleExpression('"${first}"'))).toEqual(
      toPlain(
        methodCall({
          target: stringExpr(""),
          method: "concat",
          args: [interpolationOnly],
        })
      )
    );

    const mixed = methodCall({
      target: methodCall({
        target: methodCall({
          target: stringExpr(""),
          method: "concat",
          args: [identifier("first")],
        }),
        method: "concat",
        args: [stringExpr("-")],
      }),
      method: "concat",
      args: [identifier("second")],
    });
    expect(toPlain(parseSingleExpression('"${first}-${second}"'))).toEqual(
      toPlain(mixed)
    );
  });
});
