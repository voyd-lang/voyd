import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
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
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    if (process.env.DEBUG_EFFECTS_WAT === "1") {
      writeFileSync(
        "debug-effects-continuation-compiler.wat",
        module.emitText()
      );
    }

    const table = parseEffectTable(module);
    const awaitOp = table.ops.find((op) => op.label.endsWith("Async.await"));
    const pingOp = table.ops.find((op) => op.label.endsWith("Async.ping"));
    if (!awaitOp || !pingOp) {
      throw new Error("expected await and ping ops in effect table");
    }
    const awaitKey = `${awaitOp.opIndex}`;
    const pingKey = `${pingOp.opIndex}`;

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
    expect(observed).toEqual([{ opId: awaitOp.opId, value: 5 }]);
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
      { opId: awaitOp.opId, value: 1 },
      { opId: awaitOp.opId, value: 2 },
      { opId: awaitOp.opId, value: 3 },
      { opId: awaitOp.opId, value: 4 },
      { opId: awaitOp.opId, value: 5 },
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
      { opId: awaitOp.opId, value: 11 },
      { opId: awaitOp.opId, value: 13 },
      { opId: awaitOp.opId, value: 14 },
      { opId: awaitOp.opId, value: 21 },
      { opId: awaitOp.opId, value: 23 },
      { opId: awaitOp.opId, value: 31 },
      { opId: awaitOp.opId, value: 33 },
      { opId: awaitOp.opId, value: 34 },
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
    expect(observed).toEqual([{ opId: pingOp.opId, value: 1 }]);
    expect(handlerClauseResult.value).toBe(2);
  });
});
