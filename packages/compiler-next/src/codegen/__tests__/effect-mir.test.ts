import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEffectMir } from "../effects/effect-mir.js";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import type { SemanticsPipelineResult } from "../../semantics/pipeline.js";
import type { SymbolId } from "../../semantics/ids.js";

const loadSemantics = (): SemanticsPipelineResult => {
  const source = readFileSync(
    resolve(import.meta.dirname, "__fixtures__", "effects-mir.voyd"),
    "utf8"
  );
  return semanticsPipeline(parse(source, "/proj/src/effects-mir.voyd"));
};

const resolveSymbol = (name: string, semantics: SemanticsPipelineResult): SymbolId => {
  const symbol = semantics.symbolTable.resolve(
    name,
    semantics.symbolTable.rootScope
  );
  if (typeof symbol !== "number") {
    throw new Error(`missing symbol for ${name}`);
  }
  return symbol;
};

describe("effect MIR", () => {
  it("records function effect rows and purity", () => {
    const semantics = loadSemantics();
    const mir = buildEffectMir({ semantics });

    const effectfulSym = resolveSymbol("effectful", semantics);
    const pureSym = resolveSymbol("pure_add", semantics);

    const effectful = mir.functions.get(effectfulSym);
    const pure = mir.functions.get(pureSym);

    expect(effectful?.pure).toBe(false);
    expect(semantics.typing.effects.isEmpty(effectful!.effectRow)).toBe(false);

    expect(pure?.pure).toBe(true);
    expect(semantics.typing.effects.isEmpty(pure!.effectRow)).toBe(true);
  });

  it("preserves handler clauses and tail metadata", () => {
    const semantics = loadSemantics();
    const mir = buildEffectMir({ semantics });

    const awaitOp = Array.from(mir.operations.values()).find(
      (op) => op.name === "Async.await"
    );
    expect(awaitOp).toBeDefined();
    if (!awaitOp) return;

    const handlers = Array.from(mir.handlers.values());
    expect(handlers.length).toBeGreaterThanOrEqual(2);
    const staticHandler = handlers.find((handler) =>
      handler.clauses.some(
        (clause) => clause.tailResumption?.enforcement === "static"
      )
    );
    const runtimeHandler = handlers.find((handler) =>
      handler.clauses.some(
        (clause) => clause.tailResumption?.enforcement === "runtime"
      )
    );

    expect(staticHandler).toBeDefined();
    expect(runtimeHandler).toBeDefined();
    if (!staticHandler || !runtimeHandler) return;

    const staticRow = semantics.typing.effects.getRow(staticHandler.effectRow);
    const runtimeRow = semantics.typing.effects.getRow(runtimeHandler.effectRow);
    expect(staticRow.operations).toEqual([]);
    expect(runtimeRow.operations).toEqual([]);

    const staticAwait = staticHandler.clauses.find(
      (clause) => clause.operation === awaitOp.symbol
    );
    const runtimeAwait = runtimeHandler.clauses.find(
      (clause) => clause.operation === awaitOp.symbol
    );

    expect(staticAwait?.effect).toBe(awaitOp.effect);
    expect(staticAwait?.resumeKind).toBe("tail");
    expect(staticAwait?.tailResumption?.enforcement).toBe("static");
    expect(staticAwait?.tailResumption?.calls).toBe(1);

    expect(runtimeAwait?.effect).toBe(awaitOp.effect);
    expect(runtimeAwait?.resumeKind).toBe("tail");
    expect(runtimeAwait?.tailResumption?.enforcement).toBe("runtime");
    expect(runtimeAwait?.tailResumption?.escapes).toBe(true);
  });

  it("marks calls as pure or effectful based on the inferred effect row", () => {
    const semantics = loadSemantics();
    const mir = buildEffectMir({ semantics });

    const pureSym = resolveSymbol("pure_add", semantics);
    const effectfulSym = resolveSymbol("effectful", semantics);

    const calls = Array.from(mir.calls.values());
    const pureCall = calls.find((call) => call.callee === pureSym);
    const effectfulCall = calls.find((call) => call.callee === effectfulSym);

    expect(pureCall?.effectful).toBe(false);
    expect(semantics.typing.effects.isEmpty(pureCall!.effectRow)).toBe(true);

    expect(effectfulCall?.effectful).toBe(true);
    expect(semantics.typing.effects.isEmpty(effectfulCall!.effectRow)).toBe(false);
  });
});
