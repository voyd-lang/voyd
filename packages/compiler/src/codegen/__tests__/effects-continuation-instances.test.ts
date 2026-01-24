import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileEffectFixture } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-continuation-instances.voyd"
);

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

describe("continuation instance keying", () => {
  it("emits distinct continuation functions for generic instantiations", async () => {
    const { module, entrySemantics } = await compileEffectFixture({
      entryPath: fixturePath,
    });
    if (!entrySemantics) {
      throw new Error("missing entry semantics");
    }
    const computeFn = Array.from(entrySemantics.hir.items.values()).find(
      (item) =>
        item.kind === "function" &&
        entrySemantics.symbols.getName(item.symbol) === "compute"
    );
    if (!computeFn || computeFn.kind !== "function") {
      throw new Error("missing compute function in fixture");
    }
    const moduleLabel = sanitize(entrySemantics.hir.module.path);
    const fnName = sanitize(
      entrySemantics.symbols.getName(computeFn.symbol) ?? `${computeFn.symbol}`
    );
    const contBaseName = `__cont_${moduleLabel}_${fnName}_${computeFn.symbol}`;
    const text = module.emitText();
    const matches = text.match(new RegExp(`${contBaseName}__inst\\d+`, "g")) ?? [];
    const unique = new Set(matches);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });
});
