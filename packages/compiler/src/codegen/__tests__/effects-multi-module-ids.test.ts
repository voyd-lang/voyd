import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegenProgram } from "../index.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { runEffectfulExport } from "./support/effects-harness.js";

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
    const seenA: any[] = [];
    const resultA = await runEffectfulExport<number>({
      wasm: wasmA,
      entryName: "main_effectful",
      handlers: {
        "0:0:0": (request) => {
          seenA.push(request);
          return 3;
        },
      },
    });
    expect(resultA.value).toBe(4);
    expect(seenA[0]?.effectId).toBe(0);
    expect(seenA[0]?.effectLabel).toContain("effects_multi_module_a_voyd::Alpha");

    const { module: wasmB } = buildB();
    const seenB: any[] = [];
    const resultB = await runEffectfulExport<number>({
      wasm: wasmB,
      entryName: "main_effectful",
      handlers: {
        "1:0:0": (request) => {
          seenB.push(request);
          return 7;
        },
      },
    });
    expect(resultB.value).toBe(8);
    expect(seenB[0]?.effectId).toBe(1);
    expect(seenB[0]?.effectLabel).toContain("effects_multi_module_b_voyd::Beta");

    const { module: wasmASecond } = buildA();
    const second = await runEffectfulExport<number>({
      wasm: wasmASecond,
      entryName: "main_effectful",
      handlers: { "0:0:0": () => 10 },
    });
    expect(second.table.namesBase64).toBe(resultA.table.namesBase64);
    expect(second.table.effects).toEqual(resultA.table.effects);
  });
});
