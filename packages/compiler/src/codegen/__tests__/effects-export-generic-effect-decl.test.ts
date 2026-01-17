import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import { runEffectfulExport, parseEffectTable } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-generic-effect-decl.voyd"
);

const buildModule = () => {
  const source = readFileSync(fixturePath, "utf8");
  return codegen(
    semanticsPipeline(parse(source, "/proj/src/effects-export-generic-effect-decl.voyd"))
  );
};

describe("host boundary signature derivation", () => {
  it("does not crash on unused generic effect operations", async () => {
    const { module } = buildModule();
    const parsed = parseEffectTable(module);
    const awaitOp = parsed.ops.find((op) => op.label.endsWith("Async.await"));
    const logOp = parsed.ops.find((op) => op.label.endsWith("Async.log"));
    if (!awaitOp || !logOp) {
      throw new Error("missing Async ops in effect table");
    }
    const logs: number[] = [];
    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${awaitOp.opIndex}`]: () => 2,
        [`${logOp.opIndex}`]: (_req, msg: unknown) => {
          const value = typeof msg === "number" ? msg : Number(msg);
          logs.push(value);
          return 0;
        },
      },
    });
    expect(result.value).toBe(3);
    expect(logs).toEqual([2]);
  });
});
