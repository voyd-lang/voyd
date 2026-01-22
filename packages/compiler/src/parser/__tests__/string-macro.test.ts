import { describe, expect, it } from "vitest";
import { string as stringExpr } from "../ast/init-helpers.js";
import {
  type Expr,
  IntAtom,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";

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

describe("string macro utf8 encoding", () => {
  it("encodes surrogate pairs as utf8 bytes", () => {
    expect(bytesFromStringLiteral("😀")).toEqual([240, 159, 152, 128]);
  });

  it("replaces unpaired surrogates", () => {
    const value = String.fromCharCode(0xd800);
    expect(bytesFromStringLiteral(value)).toEqual([239, 191, 189]);
  });
});
