import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegenProgram } from "../index.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { runEffectfulExport, parseEffectTable } from "./support/effects-harness.js";

const fixturePath = (name: string) =>
  resolve(import.meta.dirname, "__fixtures__", name);

const loadSemantics = (name: string) => {
  const source = readFileSync(fixturePath(name), "utf8");
  return semanticsPipeline(parse(source, name));
};

describe("effects multi-module ids", () => {
  it("keeps effect ids stable across modules and consistent with the effect table", async () => {
    const moduleA = loadSemantics("effects_multi_module_a.voyd");
    const moduleB = loadSemantics("effects_multi_module_b.voyd");
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
    const resultA = await runEffectfulExport<number>({
      wasm: wasmA,
      entryName: "main_effectful",
      handlers: {
        [`${alphaOp.opIndex}`]: (request) => {
          seenA.push(request);
          return 3;
        },
      },
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
    const resultB = await runEffectfulExport<number>({
      wasm: wasmB,
      entryName: "main_effectful",
      handlers: {
        [`${betaOp.opIndex}`]: (request) => {
          seenB.push(request);
          return 7;
        },
      },
    });
    expect(resultB.value).toBe(8);
    expect(seenB[0]?.effectId).toBe(betaOp.effectId);
    expect(seenB[0]?.label).toContain("effects_multi_module_b.voyd::Beta.pong");

    const { module: wasmASecond } = buildA();
    const tableASecond = parseEffectTable(wasmASecond);
    const second = await runEffectfulExport<number>({
      wasm: wasmASecond,
      entryName: "main_effectful",
      handlers: { [`${alphaOp.opIndex}`]: () => 10 },
    });
    expect(second.table.namesBase64).toBe(resultA.table.namesBase64);
    expect(second.table.ops).toEqual(resultA.table.ops);
    expect(tableASecond.ops).toEqual(tableA.ops);
  });
});
