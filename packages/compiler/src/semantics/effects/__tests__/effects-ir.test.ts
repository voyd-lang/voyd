import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../../parser/parser.js";
import { semanticsPipeline } from "../../pipeline.js";
import { buildEffectsLoweringInfo } from "../analysis.js";
import { buildEffectsIr } from "../ir/build.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";

const loadFixture = () => {
  const source = readFileSync(
    resolve(import.meta.dirname, "__fixtures__", "effects-lowering-info.voyd"),
    "utf8"
  );
  return semanticsPipeline(parse(source, "/proj/src/effects-lowering-info.voyd"));
};

describe("EffectsIR (overlay)", () => {
  it("classifies perform vs effectful calls", () => {
    const semantics = loadFixture();
    const info = buildEffectsLoweringInfo({
      binding: semantics.binding,
      symbolTable: getSymbolTable(semantics),
      hir: semantics.hir,
      typing: semantics.typing,
    });
    const ir = buildEffectsIr({ hir: semantics.hir, info });

    const calls = Array.from(ir.calls.values()).map((call) => ({
      kind: call.kind,
      callee:
        typeof call.calleeSymbol === "number"
          ? getSymbolTable(semantics).getSymbol(call.calleeSymbol).name
          : "<unknown>",
      op: call.operation?.name,
    }));

    expect(calls.some((call) => call.kind === "perform" && call.op === "Async.await")).toBe(true);
    expect(calls.some((call) => call.kind === "pure-call" && call.callee === "pure_add")).toBe(
      true
    );
    expect(
      calls.some((call) => call.kind === "effectful-call" && call.callee === "effectful")
    ).toBe(true);
  });
});
