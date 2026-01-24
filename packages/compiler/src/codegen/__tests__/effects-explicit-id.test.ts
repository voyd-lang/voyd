import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileEffectFixture, parseEffectTable } from "./support/effects-harness.js";

const fixturePath = (name: string) =>
  resolve(import.meta.dirname, "__fixtures__", name);

const buildModule = (name: string) =>
  compileEffectFixture({ entryPath: fixturePath(name) });

describe("explicit effect ids", () => {
  it("keeps effect ids stable across renames", async () => {
    const moduleA = await buildModule("effects-explicit-id-a.voyd");
    const moduleB = await buildModule("effects-explicit-id-b.voyd");

    const tableA = parseEffectTable(moduleA.module);
    const tableB = parseEffectTable(moduleB.module);
    const opA = tableA.ops[0];
    const opB = tableB.ops[0];
    if (!opA || !opB) {
      throw new Error("missing ops in explicit id fixtures");
    }
    expect(opA.effectId).toBe("com.example.log");
    expect(opB.effectId).toBe("com.example.log");
    expect(opA.effectIdHash.hex).toBe(opB.effectIdHash.hex);
  }, 30_000);
});
