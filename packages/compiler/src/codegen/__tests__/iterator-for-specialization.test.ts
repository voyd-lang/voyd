import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createVoydHost } from "@voyd-lang/js-host";
import { monomorphizeProgram } from "../../semantics/linking.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { optimizeProgram } from "../../optimize/pipeline.js";
import { codegenProgram } from "../index.js";
import { compileEffectFixture } from "./support/effects-harness.js";

const perf = vi.hoisted(() => ({ increment: vi.fn() }));
vi.mock("../../perf.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../perf.js")>()),
  incrementCompilerPerfCounter: perf.increment,
}));

const recordedCounters = (): string[] =>
  perf.increment.mock.calls.map(([name]) => String(name));

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__/iterator_for_specialization.voyd",
);

const watForExport = (wat: string, exportName: string): string => {
  const exportMatch = wat.match(
    new RegExp(`\\(export "${exportName}" \\(func \\$([^\\s\\)]+)\\)\\)`),
  );
  expect(exportMatch).not.toBeNull();
  const start = wat.indexOf(`(func $${exportMatch?.[1]} `);
  let depth = 0;
  for (let index = start; index < wat.length; index += 1) {
    if (wat[index] === "(") depth += 1;
    if (wat[index] === ")") depth -= 1;
    if (depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`unterminated function for export ${exportName}`);
};

const watForCalledFunction = (wat: string, caller: string): string => {
  const callerWat = watForExport(wat, caller);
  const target = callerWat.match(/\((?:return_)?call \$([^\s\)]+)/)?.[1];
  expect(target).toBeDefined();
  return watForFunction(wat, target!);
};

const watForFunction = (wat: string, functionName: string): string => {
  const start = wat.indexOf(`(func $${functionName} `);
  let depth = 0;
  for (let index = start; index < wat.length; index += 1) {
    if (wat[index] === "(") depth += 1;
    if (wat[index] === ")") depth -= 1;
    if (depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${functionName}`);
};

const compileFixture = async ({
  programOptimization,
  binaryenOptimization,
}: {
  programOptimization: boolean;
  binaryenOptimization: "none" | "release";
}) => {
  const prepared = await compileEffectFixture({
    entryPath: fixturePath,
    codegenOptions: {
      validate: true,
      effectsHostBoundary: "off",
      boundaryExports: false,
    },
  });
  const modules = [...prepared.semantics.values()];
  const monomorphized = monomorphizeProgram({
    modules,
    semantics: prepared.semantics,
  });
  const program = buildProgramCodegenView(modules, {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  const optimization = programOptimization
    ? optimizeProgram({
        program,
        modules,
        entryModuleId: prepared.entryModuleId,
      })
    : undefined;
  return codegenProgram({
    program: optimization?.program ?? program,
    entryModuleId: prepared.entryModuleId,
    optimization: optimization?.facts,
    options: {
      validate: true,
      boundaryExports: false,
      optimizationLevel: binaryenOptimization,
    },
  });
};

describe("exact standard iterator for-loop specialization", () => {
  let optimized: Awaited<ReturnType<typeof compileFixture>>;
  let releaseOptimized: Awaited<ReturnType<typeof compileFixture>>;
  let baseline: Awaited<ReturnType<typeof compileFixture>>;
  let host: Awaited<ReturnType<typeof createVoydHost>>;
  let wat: string;

  beforeAll(async () => {
    [optimized, releaseOptimized, baseline] = await Promise.all([
      compileFixture({
        programOptimization: true,
        binaryenOptimization: "none",
      }),
      compileFixture({
        programOptimization: true,
        binaryenOptimization: "release",
      }),
      compileFixture({
        programOptimization: false,
        binaryenOptimization: "none",
      }),
    ]);
    host = await createVoydHost({ wasm: optimized.wasm! });
    wat = optimized.module.emitText();
  });

  it("preserves early-return, skipping, break, continue, alias, and evaluation-once semantics", async () => {
    await expect(host.run<number>("exact_count")).resolves.toBe(6);
    await expect(host.run<number>("filtered_control_flow")).resolves.toBe(104);
  });

  it("supports wide value and object yields", async () => {
    await expect(host.run<number>("wide_and_object_results")).resolves.toBe(
      107,
    );
    await expect(host.run<number>("generic_user_iterator")).resolves.toBe(9);
  });

  it("removes dispatch and iterator state traffic for exact user iterators", () => {
    for (const exportName of [
      "exact_count",
      "filtered_control_flow",
      "generic_user_iterator",
    ]) {
      const specialized = watForExport(wat, exportName);
      expect(specialized).not.toContain("call_ref");
      expect(specialized).toMatch(/next[^\s]*__receiver_/);
    }

    const exactCount = watForExport(wat, "exact_count");
    const specializedNextName = exactCount.match(
      /\(call \$([^\s\)]*next[^\s\)]*__receiver_[^\s\)]*)/,
    )?.[1];
    expect(specializedNextName).toBeDefined();
    const specializedNext = watForFunction(wat, specializedNextName!);
    expect(specializedNext).toContain("struct.set");
    expect(specializedNext).not.toContain("call_ref");

    const baselineCount = watForExport(
      baseline.module.emitText(),
      "exact_count",
    );
    expect(baselineCount).toContain("call_ref");

    const releaseCount = watForExport(
      releaseOptimized.module.emitText(),
      "exact_count",
    );
    expect(releaseCount).not.toContain("call_ref");
    expect(releaseCount).not.toMatch(/struct\.(?:new|get|set)\b/);
    expect(recordedCounters()).toContain("codegen.exact_iterator_for.accepted");
  });

  it("keeps dynamically unknown and noncanonical iterators on general dispatch", async () => {
    await expect(host.run<number>("dynamic_count_fallback")).resolves.toBe(6);
    await expect(host.run<number>("dynamic_filtered_fallback")).resolves.toBe(
      14,
    );
    await expect(host.run<number>("noncanonical_fallback")).resolves.toBe(6);

    expect(watForCalledFunction(wat, "dynamic_count_fallback")).toContain(
      "call_ref",
    );
    expect(watForCalledFunction(wat, "dynamic_filtered_fallback")).toContain(
      "call_ref",
    );
    expect(watForExport(wat, "noncanonical_fallback")).toContain("call_ref");
    expect(
      recordedCounters().some((name) =>
        name.startsWith("codegen.exact_iterator_for.fallback."),
      ),
    ).toBe(true);
  });
});
