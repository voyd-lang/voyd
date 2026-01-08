import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../../parser/parser.js";
import { semanticsPipeline } from "../../pipeline.js";
import type { SemanticsPipelineResult } from "../../pipeline.js";
import type { SymbolId } from "../../ids.js";
import { buildEffectsLoweringInfo } from "../analysis.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";

const loadSemantics = (): SemanticsPipelineResult => {
  const source = readFileSync(
    resolve(import.meta.dirname, "__fixtures__", "effects-lowering-info.voyd"),
    "utf8"
  );
  return semanticsPipeline(parse(source, "/proj/src/effects-lowering-info.voyd"));
};

const resolveSymbol = (name: string, semantics: SemanticsPipelineResult): SymbolId => {
  const symbolTable = getSymbolTable(semantics);
  const symbol = symbolTable.resolve(name, symbolTable.rootScope);
  if (typeof symbol !== "number") {
    throw new Error(`missing symbol for ${name}`);
  }
  return symbol;
};

describe("EffectsLoweringInfo", () => {
  it("records function effect rows and purity", () => {
    const semantics = loadSemantics();
    const info = buildEffectsLoweringInfo({
      binding: semantics.binding,
      symbolTable: getSymbolTable(semantics),
      hir: semantics.hir,
      typing: semantics.typing,
    });

    const effectfulSym = resolveSymbol("effectful", semantics);
    const pureSym = resolveSymbol("pure_add", semantics);
    const handleStaticSym = resolveSymbol("handle_static", semantics);

    const effectful = info.functions.get(effectfulSym);
    const pure = info.functions.get(pureSym);
    const handleStatic = info.functions.get(handleStaticSym);

    expect(effectful?.pure).toBe(false);
    expect(effectful?.abiEffectful).toBe(true);
    expect(semantics.typing.effects.isEmpty(effectful!.effectRow)).toBe(false);

    expect(pure?.pure).toBe(true);
    expect(pure?.abiEffectful).toBe(false);
    expect(semantics.typing.effects.isEmpty(pure!.effectRow)).toBe(true);

    expect(handleStatic?.pure).toBe(true);
    expect(handleStatic?.abiEffectful).toBe(true);
  });

  it("preserves handler clauses and tail metadata", () => {
    const semantics = loadSemantics();
    const info = buildEffectsLoweringInfo({
      binding: semantics.binding,
      symbolTable: getSymbolTable(semantics),
      hir: semantics.hir,
      typing: semantics.typing,
    });

    const awaitOp = Array.from(info.operations.values()).find(
      (op) => op.name === "Async.await"
    );
    expect(awaitOp).toBeDefined();
    if (!awaitOp) return;

    const handlers = Array.from(info.handlers.values());
    expect(handlers.length).toBeGreaterThanOrEqual(2);
    const staticHandler = handlers.find((handler) =>
      handler.clauses.some((clause) => clause.tailResumption?.enforcement === "static")
    );
    const runtimeHandler = handlers.find((handler) =>
      handler.clauses.some((clause) => clause.tailResumption?.enforcement === "runtime")
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

    expect(staticAwait?.effect).toBe(awaitOp.effectSymbol);
    expect(staticAwait?.resumeKind).toBe("tail");
    expect(staticAwait?.tailResumption?.enforcement).toBe("static");
    expect(staticAwait?.tailResumption?.calls).toBe(1);

    expect(runtimeAwait?.effect).toBe(awaitOp.effectSymbol);
    expect(runtimeAwait?.resumeKind).toBe("tail");
    expect(runtimeAwait?.tailResumption?.enforcement).toBe("runtime");
    expect(runtimeAwait?.tailResumption?.escapes).toBe(true);
  });

  it("marks calls as pure or effectful based on the inferred effect row", () => {
    const semantics = loadSemantics();
    const info = buildEffectsLoweringInfo({
      binding: semantics.binding,
      symbolTable: getSymbolTable(semantics),
      hir: semantics.hir,
      typing: semantics.typing,
    });

    const pureSym = resolveSymbol("pure_add", semantics);
    const effectfulSym = resolveSymbol("effectful", semantics);

    const calls = Array.from(info.calls.values());
    const pureCall = calls.find((call) => call.callee === pureSym);
    const effectfulCall = calls.find((call) => call.callee === effectfulSym);

    expect(pureCall?.effectful).toBe(false);
    expect(semantics.typing.effects.isEmpty(pureCall!.effectRow)).toBe(true);

    expect(effectfulCall?.effectful).toBe(true);
    expect(semantics.typing.effects.isEmpty(effectfulCall!.effectRow)).toBe(false);
  });
});
