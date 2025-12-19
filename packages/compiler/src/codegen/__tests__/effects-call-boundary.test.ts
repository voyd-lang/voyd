import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import {
  runEffectfulExport,
  type EffectHandler,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-call-boundary.voyd"
);

describe("effects call boundary", () => {
  it("resumes into caller after effectful call", async () => {
    const source = readFileSync(fixturePath, "utf8");
    const semantics = semanticsPipeline(
      parse(source, "/proj/src/effects-call-boundary.voyd")
    );
    const { module } = codegen(semantics);

    const handler: EffectHandler = (_request, ...args) => args[0] as number;
    const handlers: Record<string, EffectHandler> = {
      "0:0:0": handler,
    };

    const outer = await runEffectfulExport<number>({
      wasm: module,
      entryName: "outer_effectful",
      handlers,
    });
    expect(outer.value).toBe(8);

    const twice = await runEffectfulExport<number>({
      wasm: module,
      entryName: "outer_twice_effectful",
      handlers,
    });
    expect(twice.value).toBe(5);

    const nested = await runEffectfulExport<number>({
      wasm: module,
      entryName: "outer_nested_effectful",
      handlers,
    });
    expect(nested.value).toBe(18);
  });
});
