import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createVoydHost } from "@voyd/js-host";
import { createEffectsImports } from "./support/wasm-imports.js";
import { compileEffectFixture } from "./support/effects-harness.js";
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
const hostTailNoResumeFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-host-tail-no-resume.voyd"
);
const handlerHostMutationFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-handler-host-mutation.voyd"
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

  const registerStdTestFallbackHandlers = async (
    host: Awaited<ReturnType<typeof createVoydHost>>
  ): Promise<void> => {
    host.table.ops
      .filter((op) => op.effectId.endsWith("std::std::test::assertions::Test"))
      .forEach((op) => {
        host.registerHandler(
          op.effectId,
          op.opId,
          op.signatureHash,
          ({ resume, tail }) => (op.resumeKind === "tail" ? tail() : resume())
        );
      });
  };

  it("runs handlers inside wasm", async () => {
    const { wasm } = await buildModule();
    const instance = instantiateEffectsModule(wasm);
    const main = instance.exports.main as CallableFunction;
    expect(main()).toBe(3);
  });

  it("rejects escaped resume at compile time", async () => {
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
    const runHostEntry = async (entryName: string): Promise<number> => {
      const host = await createVoydHost({ wasm });
      await registerStdTestFallbackHandlers(host);
      const count = host.registerHandlersByLabelSuffix({
        "Async.await": ({ resume, end }, x) => {
          if (typeof x !== "number") {
            throw new Error(`expected i32 arg, got ${typeof x}`);
          }
          return x > 4 ? resume(x) : end(Math.trunc(x / 2));
        },
      });
      expect(count).toBe(1);
      return host.run<number>(entryName);
    };

    expect(await runHostEntry("host_resume")).toBe(10);
    expect(await runHostEntry("host_no_resume")).toBe(2);
  });

  it("rejects host end(...) for tail handlers", async () => {
    const { wasm } = await compileEffectFixture({ entryPath: hostTailNoResumeFixturePath });
    const host = await createVoydHost({ wasm });
    await registerStdTestFallbackHandlers(host);
    const count = host.registerHandlersByLabelSuffix({
      "Async.await": ({ end }, x) => {
        if (typeof x !== "number") {
          throw new Error(`expected i32 arg, got ${typeof x}`);
        }
        return end(x);
      },
    });
    expect(count).toBe(1);

    await expect(
      host.run<number>("host_tail"),
    ).rejects.toThrow(/must return tail/i);
  });

  it("allows handler clauses to mutate hosting locals for resume and tail", async () => {
    const { wasm } = await compileEffectFixture({ entryPath: handlerHostMutationFixturePath });
    const instance = instantiateEffectsModule(wasm);

    const resumeTarget = instance.exports
      .resume_handler_mutates_host as CallableFunction;
    const tailTarget = instance.exports.tail_handler_mutates_host as CallableFunction;

    expect(resumeTarget(1)).toBe(5);
    expect(resumeTarget(0)).toBe(15);
    expect(tailTarget()).toBe(7);
  });
});
