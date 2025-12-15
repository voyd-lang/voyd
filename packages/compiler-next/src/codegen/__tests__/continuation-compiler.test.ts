import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import {
  parseEffectTable,
  runEffectfulExport,
  type EffectHandler,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-continuation-compiler.voyd"
);

describe("continuation compiler", () => {
  it("resumes without re-running prefix control flow", async () => {
    const source = readFileSync(fixturePath, "utf8");
    const semantics = semanticsPipeline(
      parse(source, "/proj/src/effects-continuation-compiler.voyd")
    );
    const { module } = codegen(semantics);
    if (process.env.DEBUG_EFFECTS_WAT === "1") {
      writeFileSync(
        "debug-effects-continuation-compiler.wat",
        module.emitText()
      );
    }

    const table = parseEffectTable(module);
    const asyncEffect = table.effects.find((effect) => effect.label.endsWith("Async"));
    if (!asyncEffect) {
      throw new Error("expected Async effect in effect table");
    }
    const opSuffix = (label: string): string => label.split(".").at(-1) ?? label;
    const awaitOp = asyncEffect.ops.find((op) => opSuffix(op.label) === "await");
    const pingOp = asyncEffect.ops.find((op) => opSuffix(op.label) === "ping");
    if (!awaitOp || !pingOp) {
      throw new Error("expected await and ping ops in effect table");
    }
    const awaitKey = `${asyncEffect.id}:${awaitOp.id}:${awaitOp.resumeKind}`;
    const pingKey = `${asyncEffect.id}:${pingOp.id}:${pingOp.resumeKind}`;

    const observed: Array<{ opId: number; value: number }> = [];
    const handler: EffectHandler = (request, value) => {
      observed.push({ opId: request.opId, value: value as number });
      return value as number;
    };
    const blockResult = await runEffectfulExport<number>({
      wasm: module,
      entryName: "block_test_effectful",
      handlers: {
        [awaitKey]: handler,
        [pingKey]: handler,
      },
    });
    expect(blockResult.value).toBe(6);
    expect(observed).toEqual([{ opId: awaitOp.id, value: 5 }]);
    observed.length = 0;

    const whileResult = await runEffectfulExport<number>({
      wasm: module,
      entryName: "while_test_effectful",
      handlers: {
        [awaitKey]: handler,
        [pingKey]: handler,
      },
    });
    expect(observed).toEqual([
      { opId: awaitOp.id, value: 1 },
      { opId: awaitOp.id, value: 2 },
      { opId: awaitOp.id, value: 3 },
      { opId: awaitOp.id, value: 4 },
      { opId: awaitOp.id, value: 5 },
    ]);
    expect(whileResult.value).toBe(15);
    observed.length = 0;

    const nestedResult = await runEffectfulExport<number>({
      wasm: module,
      entryName: "nested_break_continue_test_effectful",
      handlers: {
        [awaitKey]: handler,
        [pingKey]: handler,
      },
    });
    expect(observed).toEqual([
      { opId: awaitOp.id, value: 11 },
      { opId: awaitOp.id, value: 13 },
      { opId: awaitOp.id, value: 14 },
      { opId: awaitOp.id, value: 21 },
      { opId: awaitOp.id, value: 23 },
      { opId: awaitOp.id, value: 31 },
      { opId: awaitOp.id, value: 33 },
      { opId: awaitOp.id, value: 34 },
    ]);
    expect(nestedResult.value).toBe(180);
    observed.length = 0;

    const handlerClauseResult = await runEffectfulExport<number>({
      wasm: module,
      entryName: "handler_clause_perform_test_effectful",
      handlers: {
        [awaitKey]: handler,
        [pingKey]: handler,
      },
    });
    expect(observed).toEqual([{ opId: pingOp.id, value: 1 }]);
    expect(handlerClauseResult.value).toBe(2);
  });
});
