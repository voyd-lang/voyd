import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegenProgram } from "../index.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import type {
  ModuleGraph,
  ModuleNode,
  ModulePath,
} from "../../modules/types.js";
import {
  createEffectInterner,
  createEffectTable,
} from "../../semantics/effects/effect-table.js";
import { createTypeArena } from "../../semantics/typing/type-arena.js";
import {
  runEffectfulExport,
  parseEffectTable,
  type EffectHandler,
} from "./support/effects-harness.js";

const fixturePath = (name: string) =>
  resolve(import.meta.dirname, "__fixtures__", name);

const loadSemantics = (name: string, typing?: { arena: any; effects: any }) => {
  const source = readFileSync(fixturePath(name), "utf8");
  const form = parse(source, name);
  const path: ModulePath = { namespace: "src", segments: [] };
  const module: ModuleNode = {
    id: name,
    path,
    origin: { kind: "file", filePath: name },
    ast: form,
    source,
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: module.id,
    modules: new Map([[module.id, module]]),
    diagnostics: [],
  };
  return semanticsPipeline({
    module,
    graph,
    exports: new Map(),
    dependencies: new Map(),
    typing,
  });
};

describe("effects multi-module ids", () => {
  it("keeps effect ids stable across modules and consistent with the effect table", async () => {
    const arena = createTypeArena();
    const effectInterner = createEffectInterner();
    const moduleA = loadSemantics("effects_multi_module_a.voyd", {
      arena,
      effects: createEffectTable({ interner: effectInterner }),
    });
    const moduleB = loadSemantics("effects_multi_module_b.voyd", {
      arena,
      effects: createEffectTable({ interner: effectInterner }),
    });
    const program = buildProgramCodegenView([moduleA, moduleB]);

    const buildA = () =>
      codegenProgram({
        program,
        entryModuleId: moduleA.moduleId,
      });
    const buildB = () =>
      codegenProgram({
        program,
        entryModuleId: moduleB.moduleId,
      });

    const { module: wasmA } = buildA();
    const tableA = parseEffectTable(wasmA);
    const alphaOp = tableA.ops.find((op) => op.label.endsWith("Alpha.ping"));
    if (!alphaOp) {
      throw new Error("missing Alpha.ping op entry");
    }
    const seenA: any[] = [];
    const handlersA: Record<string, EffectHandler> = {};
    tableA.ops.forEach((op) => {
      handlersA[`${op.opIndex}`] = () => 0;
    });
    handlersA[`${alphaOp.opIndex}`] = (request) => {
      seenA.push(request);
      return 3;
    };
    const resultA = await runEffectfulExport<number>({
      wasm: wasmA,
      entryName: "main_effectful",
      handlers: handlersA,
    });
    expect(resultA.value).toBe(4);
    expect(seenA[0]?.effectId).toBe(alphaOp.effectId);
    expect(seenA[0]?.label).toContain("effects_multi_module_a.voyd::Alpha.ping");

    const { module: wasmB } = buildB();
    const tableB = parseEffectTable(wasmB);
    const betaOp = tableB.ops.find((op) => op.label.endsWith("Beta.pong"));
    if (!betaOp) {
      throw new Error("missing Beta.pong op entry");
    }
    const seenB: any[] = [];
    const handlersB: Record<string, EffectHandler> = {};
    tableB.ops.forEach((op) => {
      handlersB[`${op.opIndex}`] = () => 0;
    });
    handlersB[`${betaOp.opIndex}`] = (request) => {
      seenB.push(request);
      return 7;
    };
    const resultB = await runEffectfulExport<number>({
      wasm: wasmB,
      entryName: "main_effectful",
      handlers: handlersB,
    });
    expect(resultB.value).toBe(8);
    expect(seenB[0]?.effectId).toBe(betaOp.effectId);
    expect(seenB[0]?.label).toContain("effects_multi_module_b.voyd::Beta.pong");

    const { module: wasmASecond } = buildA();
    const tableASecond = parseEffectTable(wasmASecond);
    const handlersASecond: Record<string, EffectHandler> = {};
    tableASecond.ops.forEach((op) => {
      handlersASecond[`${op.opIndex}`] = () => 0;
    });
    handlersASecond[`${alphaOp.opIndex}`] = () => 10;
    const second = await runEffectfulExport<number>({
      wasm: wasmASecond,
      entryName: "main_effectful",
      handlers: handlersASecond,
    });
    expect(second.table.namesBase64).toBe(resultA.table.namesBase64);
    expect(second.table.ops).toEqual(resultA.table.ops);
    expect(tableASecond.ops).toEqual(tableA.ops);
  });
});
