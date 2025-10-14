import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runWasm } from "../cli/exec.js";
import { runTypeInternerFromSource } from "../semantics/types/type-interner-harness.js";

const runWasmFixtureUrl = new URL(
  "./fixtures/voyd/run-wasm-regression.voyd",
  import.meta.url
);
const runWasmFixturePath = fileURLToPath(runWasmFixtureUrl);

describe("type interner e2e harness", () => {
  test("collects canonicalization stats for the wasm regression fixture", async () => {
    const source = await readFile(runWasmFixturePath, "utf8");
    const { stats, events } = await runTypeInternerFromSource(source, {
      recordEvents: true,
    });
    const fingerprintCount = new Set(
      events.map((event) => event.fingerprint)
    ).size;
    expect(stats.observed).toBeGreaterThan(1000);
    expect(stats.canonical).toBeGreaterThan(200);
    expect(stats.reused).toBeGreaterThan(1000);
    expect(fingerprintCount).toBeGreaterThan(30);
  });

  test("baseline wasm execution still traps with illegal cast", async () => {
    await expect(runWasm(runWasmFixturePath)).rejects.toThrow(/illegal cast/i);
  });
});
