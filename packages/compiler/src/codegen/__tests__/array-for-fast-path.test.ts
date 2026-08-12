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
  "__fixtures__/array_for_fast_path.voyd",
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

const compileFixture = async () => {
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
  const optimized = optimizeProgram({
    program,
    modules,
    entryModuleId: prepared.entryModuleId,
  });
  return codegenProgram({
    program: optimized.program,
    entryModuleId: prepared.entryModuleId,
    optimization: optimized.facts,
    options: { validate: true, boundaryExports: false },
  });
};

describe("intrinsic Array<T> for-loop fast path", () => {
  let compiled: Awaited<ReturnType<typeof compileFixture>>;
  let host: Awaited<ReturnType<typeof createVoydHost>>;
  let wat: string;

  beforeAll(async () => {
    compiled = await compileFixture();
    host = await createVoydHost({ wasm: compiled.wasm! });
    wat = compiled.module.emitText();
  });

  it("preserves dynamic growth, storage replacement, and evaluation-once semantics", async () => {
    await expect(
      host.run<number>("dynamic_growth_and_storage_replacement"),
    ).resolves.toBe(10);
    await expect(host.run<number>("iterable_evaluated_once")).resolves.toBe(
      103,
    );
    await expect(
      host.run<number>("replacement_does_not_retarget_iterator"),
    ).resolves.toBe(3);
  });

  it("preserves break, continue, generic, wide-value, and object element behavior", async () => {
    await expect(host.run<number>("break_and_continue")).resolves.toBe(21);
    await expect(host.run<number>("generic_and_wide_values")).resolves.toBe(10);
    await expect(host.run<number>("object_elements")).resolves.toBe(11);
  });

  it("removes iterator dispatch and Option machinery only for intrinsic Arrays", () => {
    const intrinsic = watForExport(wat, "object_elements");
    expect(intrinsic).toContain("array_for_loop");
    expect(intrinsic).not.toContain("call_ref");
    expect(intrinsic).not.toMatch(
      /ArrayIterator|optional__Some|optional__None/,
    );

    const custom = watForExport(wat, "custom_sequence_fallback");
    expect(custom).not.toContain("array_for_loop");
    expect(custom).toContain("call_ref");
    expect(recordedCounters()).toContain(
      "codegen.intrinsic_array_for.accepted",
    );
    expect(recordedCounters()).toContain(
      "codegen.intrinsic_array_for.fallback.shape",
    );
  });

  it("leaves non-intrinsic Sequence implementations on the general path", async () => {
    await expect(host.run<number>("custom_sequence_fallback")).resolves.toBe(6);
  });

  it("leaves macro-generated lookalike loops with meaningful arm tails intact", () => {
    const manual = watForExport(wat, "manual_array_iterator_fallback");
    expect(manual).not.toContain("array_for_loop");
    expect(manual).toContain("call_ref");
    expect(manual).toContain("add_to");
  });
});
