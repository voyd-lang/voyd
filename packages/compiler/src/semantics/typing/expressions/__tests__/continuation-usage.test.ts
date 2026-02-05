import { describe, expect, it } from "vitest";
import { parse } from "../../../../parser/parser.js";
import { semanticsPipeline } from "../../../pipeline.js";
import { getSymbolTable } from "../../../_internal/symbol-table.js";
import type { HirFunction } from "../../../hir/index.js";
import { analyzeContinuationUsage } from "../continuation-usage.js";

const usageForFirstParam = ({
  source,
  functionName,
}: {
  source: string;
  functionName: string;
}) => {
  const semantics = semanticsPipeline(parse(source, "continuation-usage.voyd"));
  const symbolTable = getSymbolTable(semantics);
  const symbol = symbolTable.resolve(functionName, symbolTable.rootScope);
  expect(typeof symbol).toBe("number");
  if (typeof symbol !== "number") {
    throw new Error(`missing function symbol ${functionName}`);
  }

  const fn = Array.from(semantics.hir.items.values()).find(
    (item): item is HirFunction => item.kind === "function" && item.symbol === symbol,
  );
  expect(fn).toBeDefined();
  if (!fn) {
    throw new Error(`missing function item ${functionName}`);
  }

  const targetSymbol = fn.parameters[0]?.symbol;
  expect(typeof targetSymbol).toBe("number");
  if (typeof targetSymbol !== "number") {
    throw new Error(`missing first parameter for ${functionName}`);
  }

  return analyzeContinuationUsage({
    exprId: fn.body,
    targetSymbol,
    hir: semantics.hir,
  });
};

describe("continuation usage analysis", () => {
  it("treats calls in return paths as terminating", () => {
    const usage = usageForFirstParam({
      source: `
fn test(cb: fn(i32) -> i32, flag: bool) -> i32
  if flag then:
    return cb(1)
  cb(2)
`,
      functionName: "test",
    });

    expect(usage.min).toBe(1);
    expect(usage.max).toBe(1);
    expect(usage.escapes).toBe(false);
  });

  it("marks forwarded callbacks as escapes", () => {
    const usage = usageForFirstParam({
      source: `
fn forward(cb: fn(i32) -> i32, value: i32) -> i32
  cb(value)

fn test(cb: fn(i32) -> i32) -> i32
  forward(cb, 7)
`,
      functionName: "test",
    });

    expect(usage.min).toBe(0);
    expect(usage.max).toBe(0);
    expect(usage.escapes).toBe(true);
  });

  it("uses an infinite upper bound for looped calls", () => {
    const usage = usageForFirstParam({
      source: `
fn test(cb: fn(i32) -> i32, count: i32) -> i32
  var i = 0
  while i < count do:
    cb(i)
    i = i + 1
  0
`,
      functionName: "test",
    });

    expect(usage.min).toBe(0);
    expect(usage.max).toBe(Number.POSITIVE_INFINITY);
    expect(usage.escapes).toBe(false);
  });
});
