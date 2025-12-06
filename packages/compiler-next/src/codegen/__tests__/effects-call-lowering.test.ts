import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import type { SemanticsPipelineResult } from "../../semantics/pipeline.js";
import type { SymbolId } from "../../semantics/ids.js";

const markEffectful = (
  semantics: SemanticsPipelineResult,
  names: readonly string[]
): void => {
  const effectRow = semantics.typing.effects.internRow({
    operations: [{ name: "Test.effect" }],
  });
  const symbols: SymbolId[] = names.map((name) => {
    const symbol = semantics.symbolTable.resolve(
      name,
      semantics.symbolTable.rootScope
    );
    if (typeof symbol !== "number") {
      throw new Error(`missing symbol for ${name}`);
    }
    const signature = semantics.typing.functions.getSignature(symbol);
    if (!signature) {
      throw new Error(`missing signature for ${name}`);
    }
    signature.effectRow = effectRow;
    return symbol;
  });

  semantics.hir.expressions.forEach((expr) => {
    if (expr.exprKind === "call") {
      semantics.typing.effects.setExprEffect(expr.id, effectRow);
    }
  });
};

const loadModuleText = (): string => {
  const source = readFileSync(
    resolve(
      import.meta.dirname,
      "__fixtures__",
      "effects-call-lowering.voyd"
    ),
    "utf8"
  );
  const semantics = semanticsPipeline(
    parse(source, "/proj/src/effects-call-lowering.voyd")
  );
  markEffectful(semantics, ["effectful_value", "forward"]);
  const { module } = codegen(semantics);
  return module.emitText();
};

describe("effectful call lowering", () => {
  it("returns $Outcome values from effectful functions", () => {
    const text = loadModuleText();
    expect(text).toMatch(
      /\(func \$[^\s)]*effectful_value[\s\S]*\(result \(ref null \$voydOutcome\)\)/
    );
    expect(text).toContain("struct.new $voydOutcome");
    expect(text).toContain("(i32.const 0"); // OUTCOME_TAGS.value
  });

  it("dispatches effectful callees through the outcome tag path", () => {
    const text = loadModuleText();
    expect(text).toContain("struct.get $voydOutcome $tag"); // tag access
    expect(text).toContain("struct.get $voydOutcome $payload"); // payload access
    expect(text).toContain("unreachable"); // effect branch placeholder
  });
});
