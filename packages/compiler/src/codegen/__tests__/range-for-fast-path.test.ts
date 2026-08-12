import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createVoydHost } from "@voyd-lang/js-host";
import { monomorphizeProgram } from "../../semantics/linking.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { optimizeProgram } from "../../optimize/pipeline.js";
import { codegenProgram } from "../index.js";
import { compileEffectFixture } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__/range_for_fast_path.voyd",
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
  const generated = codegenProgram({
    program: optimized.program,
    entryModuleId: prepared.entryModuleId,
    optimization: optimized.facts,
    options: { validate: true, boundaryExports: false },
  });
  const baseline = codegenProgram({
    program,
    entryModuleId: prepared.entryModuleId,
    options: { validate: true, boundaryExports: false },
  });
  return { prepared, optimized, generated, baseline };
};

describe("intrinsic Range<i32> for-loop fast path", () => {
  it("emits a direct counted loop and retains stable-field forwarding", async () => {
    const { prepared, optimized, generated, baseline } = await compileFixture();
    const host = await createVoydHost({ wasm: generated.wasm! });
    await expect(host.run<number>("stable_range_sum")).resolves.toBe(35);

    const forwarding = optimized.facts.stableFieldLoadForwarding.get(
      prepared.entryModuleId,
    );
    expect(forwarding?.size).toBe(1);

    const generatedWat = watForExport(
      generated.module.emitText(),
      "stable_range_sum",
    );
    const baselineWat = watForExport(
      baseline.module.emitText(),
      "stable_range_sum",
    );
    expect(generatedWat).toContain("range_for_loop");
    expect(generatedWat).not.toContain("$std__range__RangeIterator");
    expect(generatedWat).not.toContain("call_ref");
    expect(generatedWat.match(/\(struct\.get\b/g)?.length ?? 0).toBeLessThan(
      baselineWat.match(/\(struct\.get\b/g)?.length ?? 0,
    );
  });
});
