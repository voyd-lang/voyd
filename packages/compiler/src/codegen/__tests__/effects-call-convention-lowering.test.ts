import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import type { SemanticsPipelineResult } from "../../semantics/pipeline.js";
import type { EffectRowId } from "../../semantics/ids.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-call-convention.voyd"
);
const fixtureVirtualPath = "/proj/src/effects-call-convention.voyd";

const setEffectRowFor = ({
  semantics,
  names,
  effectRow,
}: {
  semantics: SemanticsPipelineResult;
  names: readonly string[];
  effectRow: EffectRowId;
}) => {
  semantics.hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    const name = semantics.symbols.getName(item.symbol) ?? `${item.symbol}`;
    if (!names.includes(name)) return;
    const signature = semantics.typing.functions.getSignature(item.symbol);
    if (signature) {
      semantics.typing.functions.setSignature(item.symbol, {
        ...signature,
        effectRow,
      });
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
    const calleeName = semantics.symbols.getName(callee.symbol) ?? `${callee.symbol}`;
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
      (desc as { effectRow: EffectRowId }).effectRow = effectRow;
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

const emittedFunction = (text: string, name: string): string => {
  const match = text.match(
    new RegExp(`\\(func \\$[^\\s)]*${name}[^\\n]*[\\s\\S]*?\\n \\)`, "m")
  );
  expect(match, name).not.toBeNull();
  return match?.[0] ?? "";
};

describe("effectful call convention lowering", () => {
  it("widens effectful functions with handler params and $Outcome results", () => {
    const text = loadModuleText();
    expect(text).toMatch(
      /\(func \$[^\s)]*effectful_value[\s\S]*\(param(?: \$\d+)? \(ref null \$voydHandlerFrame\)\)[\s\S]*\(result \(ref null \$voydOutcome\)\)/
    );
    expect(text).toMatch(
      /\(func \$[^\s)]*run[\s\S]*\(param(?: \$\d+)? \(ref null \$voydHandlerFrame\)[\s\S]*\(result \(ref null \$voydOutcome\)\)/
    );
  });

  it("passes ref.null handlers for pure direct and closure calls", () => {
    const text = loadModuleText();
    expect(text).toMatch(
      /\(func \$[^\s)]*call_direct[\s\S]*call \$[^\s)]*effectful_value[^\)]*\(ref\.null none\)/
    );
    const callClosure = emittedFunction(text, "call_closure");
    expect(callClosure).toMatch(/call_ref[\s\S]*\(ref\.null none\)/);
  });

  it("threads handler locals through effectful and direct trait-dispatched calls", () => {
    const text = loadModuleText();
    expect(text).toMatch(
      /\(func \$[^\s)]*effectful_forward[\s\S]*\(param(?: \$\d+)? \(ref null \$voydHandlerFrame\)\)[\s\S]*call \$[^\s)]*effectful_value[^\)]*\(local\.get \$0\)/
    );
    const callTrait = emittedFunction(text, "call_trait");
    expect(callTrait).toContain("call $__has_type");
    expect(callTrait).toMatch(/call \$[^\s)]*run_[\s\S]*\(ref\.null none\)/);
    expect(callTrait).not.toContain("__method_");
    expect(callTrait).not.toContain("call $__lookup_method_accessor");
  });
});
