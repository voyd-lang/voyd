import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { noResume } from "@voyd/js-host";
import { createEffectsImports } from "./support/wasm-imports.js";
import {
  compileEffectFixture,
  parseEffectTable,
  runEffectfulExport,
} from "./support/effects-harness.js";
import { wasmBufferSource } from "./support/wasm-utils.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-e2e.voyd"
);
const invalidTailFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-invalid-tail.voyd"
);
const invalidResumeFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-invalid-resume.voyd"
);
const internalNoResumeFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-internal-no-resume.voyd"
);
const hostNoResumeFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-host-no-resume.voyd"
);

const buildModule = () => compileEffectFixture({ entryPath: fixturePath });

describe("effects wasm e2e", () => {
  const instantiateEffectsModule = (
    wasm: Uint8Array<ArrayBufferLike> | ArrayBuffer,
  ) =>
    new WebAssembly.Instance(
      new WebAssembly.Module(
        wasmBufferSource(wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm)),
      ),
      createEffectsImports(),
    );

  it("runs handlers inside wasm", async () => {
    const { wasm } = await buildModule();
    const instance = instantiateEffectsModule(wasm);
    const main = instance.exports.main as CallableFunction;
    expect(main()).toBe(3);
  });

  it("rejects double resume at compile time", async () => {
    let caught: unknown;
    try {
      await compileEffectFixture({ entryPath: invalidResumeFixturePath });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const parsed = JSON.parse((caught as Error).message) as Array<{ code?: string }>;
    expect(parsed.some((diag) => diag.code === "TY0035")).toBe(true);
  });

  it("rejects conditional missing tail at compile time", async () => {
    let caught: unknown;
    try {
      await compileEffectFixture({ entryPath: invalidTailFixturePath });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const parsed = JSON.parse((caught as Error).message) as Array<{ code?: string }>;
    expect(parsed.some((diag) => diag.code === "TY0015")).toBe(true);
  });

  it("supports direct performs inside a try body", async () => {
    const { wasm } = await buildModule();
    const instance = instantiateEffectsModule(wasm);
    const target = instance.exports.perform_in_try as CallableFunction;
    expect(target()).toBe(15);
  });

  it("supports effects inside lambdas", async () => {
    const { wasm } = await buildModule();
    const instance = instantiateEffectsModule(wasm);
    const target = instance.exports.lambda_perform as CallableFunction;
    expect(target()).toBe(25);
  });

  it("treats resume as a return in internal handlers", async () => {
    const { wasm } = await compileEffectFixture({ entryPath: internalNoResumeFixturePath });
    const instance = instantiateEffectsModule(wasm);
    const target = instance.exports.internal_no_resume as CallableFunction;
    expect(target(5)).toBe(10);
    expect(target(4)).toBe(2);
  });

  it("supports host handlers that can choose not to resume", async () => {
    const { wasm } = await compileEffectFixture({ entryPath: hostNoResumeFixturePath });
    const handler = (_request: unknown, x: unknown) => {
      if (typeof x !== "number") {
        throw new Error(`expected i32 arg, got ${typeof x}`);
      }
      if (x > 4) return x;
      return noResume(Math.trunc(x / 2));
    };

    const awaitLabel = (() => {
      const table = parseEffectTable(wasm);
      const op = table.ops.find((entry) =>
        entry.label.endsWith("Async.await") || entry.label.includes("Async.await")
      );
      if (!op) {
        throw new Error("missing Async.await op entry");
      }
      return op.label;
    })();

    const resumed = await runEffectfulExport<number>({
      wasm,
      entryName: "host_resume",
      handlers: { [awaitLabel]: handler },
    });
    expect(resumed.value).toBe(10);

    const stopped = await runEffectfulExport<number>({
      wasm,
      entryName: "host_no_resume",
      handlers: { [awaitLabel]: handler },
    });
    expect(stopped.value).toBe(2);
  });
});
