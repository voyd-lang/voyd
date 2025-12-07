import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import type { SemanticsPipelineResult } from "../../semantics/pipeline.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-call.voyd"
);
const fixtureVirtualPath = "/proj/src/effects-call.voyd";

const setEffectRowFor = ({
  semantics,
  names,
  effectRow,
}: {
  semantics: SemanticsPipelineResult;
  names: readonly string[];
  effectRow: number;
}) => {
  semantics.hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    const name = semantics.symbolTable.getSymbol(item.symbol).name;
    if (!names.includes(name)) return;
    const signature = semantics.typing.functions.getSignature(item.symbol);
    if (signature) {
      signature.effectRow = effectRow;
    }
  });
};

const markEffectful = (semantics: SemanticsPipelineResult): void => {
  const effectRow = semantics.typing.effects.internRow({
    operations: [{ name: "Test.effect" }],
  });
  setEffectRowFor({
    semantics,
    names: ["effectful_value", "run", "effectful_forward"],
    effectRow,
  });
  setEffectRowFor({
    semantics,
    names: ["call_direct", "call_closure", "call_trait"],
    effectRow: semantics.typing.effects.emptyRow,
  });

  semantics.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "call") return;
    const callee = semantics.hir.expressions.get(expr.callee);
    if (callee?.exprKind !== "identifier") return;
    const calleeName = semantics.symbolTable.getSymbol(callee.symbol).name;
    if (calleeName === "effectful_value" || calleeName === "run") {
      semantics.typing.effects.setExprEffect(expr.id, effectRow);
    }
  });

  semantics.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "lambda") return;
    const typeId = semantics.typing.resolvedExprTypes.get(expr.id);
    if (typeof typeId !== "number") return;
    const desc = semantics.typing.arena.get(typeId);
    if (desc.kind === "function") {
      desc.effectRow = effectRow;
    }
  });
};

const loadModuleText = (): string => {
  const source = readFileSync(fixturePath, "utf8");
  const semantics = semanticsPipeline(parse(source, fixtureVirtualPath));
  markEffectful(semantics);
  const { module } = codegen(semantics);
  return module.emitText();
};

describe("effectful call lowering", () => {
  it("widens effectful functions with handler params and $Outcome results", () => {
    const text = loadModuleText();
    expect(text).toMatch(
      /\(func \$[^\s)]*effectful_value[\s\S]*\(param(?: \$\d+)? eqref\)[\s\S]*\(result \(ref null \$voydOutcome\)\)/
    );
    expect(text).toMatch(
      /\(func \$[^\s)]*run[\s\S]*\(param(?: \$\d+)? eqref[\s\S]*\(result \(ref null \$voydOutcome\)\)/
    );
  });

  it("passes ref.null handlers for pure direct and closure calls", () => {
    const text = loadModuleText();
    expect(text).toMatch(
      /\(func \$[^\s)]*call_direct[\s\S]*call \$[^\s)]*effectful_value[^\)]*\(ref\.null none\)/
    );
    expect(text).toMatch(
      /\(func \$[^\s)]*call_closure[\s\S]*call_ref[^\)]*ref\.null none/
    );
  });

  it("threads handler locals through effectful and trait-dispatched calls", () => {
    const text = loadModuleText();
    expect(text).toMatch(
      /\(func \$[^\s)]*effectful_forward[\s\S]*\(param(?: \$\d+)? eqref\)[\s\S]*call \$[^\s)]*effectful_value[^\)]*\(local\.get \$0\)/
    );
    expect(text).toMatch(
      /\(func \$[^\s)]*call_trait[\s\S]*call_ref[^\)]*ref\.null none/
    );
  });
});
