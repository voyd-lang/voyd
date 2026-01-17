import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-continuation-instances.voyd"
);

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

describe("continuation instance keying", () => {
  it("emits distinct continuation functions for generic instantiations", () => {
    const source = readFileSync(fixturePath, "utf8");
    const semantics = semanticsPipeline(
      parse(source, "/proj/src/effects-continuation-instances.voyd")
    );
    const { module } = codegen(semantics);
    const computeFn = Array.from(semantics.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        semantics.symbols.getName(item.symbol) === "compute"
    );
    if (!computeFn || computeFn.kind !== "function") {
      throw new Error("missing compute function in fixture");
    }
    const moduleLabel = sanitize(semantics.hir.module.path);
    const fnName = sanitize(
      semantics.symbols.getName(computeFn.symbol) ?? `${computeFn.symbol}`
    );
    const contBaseName = `__cont_${moduleLabel}_${fnName}_${computeFn.symbol}`;
    const text = module.emitText();
    const matches = text.match(new RegExp(`${contBaseName}__inst\\d+`, "g")) ?? [];
    const unique = new Set(matches);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });
});
