import { describe, expect, it } from "vitest";
import { codegenProgram } from "../../codegen/index.js";
import { buildOptimized } from "./pipeline-test-helpers.js";

describe("compiler optimization pipeline: runtime-facts", () => {
  it("lowers exact nominal field reads to direct struct loads", async () => {
    const { optimized, entryModuleId } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

fn read(vec: Vec2) -> i32
  vec.x + vec.y

pub fn main() -> i32
  let vec = Vec2 { x: 1, y: 2 }
  read(vec)
`,
      },
    });

    const candidates =
      optimized.facts.runtimeTypeCheckElisionFieldAccesses.get("src::main");
    expect(candidates?.size).toBeGreaterThanOrEqual(2);

    const optimizedCodegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: false,
        runtimeDiagnostics: false,
      },
    });
    const baselineCodegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      options: {
        optimize: false,
        validate: false,
        runtimeDiagnostics: false,
      },
    });
    const optimizedWasmText = optimizedCodegen.module.emitText();
    const baselineWasmText = baselineCodegen.module.emitText();

    expect(optimizedWasmText).not.toContain("call $__has_type");
    expect(optimizedWasmText).not.toContain("call $__lookup_field_accessor");
    expect(baselineWasmText).toContain("call $__lookup_field_accessor");
  });

  it("marks direct object-literal field accesses for semantic copy forwarding", async () => {
    const { optimized, entryModuleId } = await buildOptimized({
      files: {
        "main.voyd": `
obj Vec2 {
  x: i32,
  y: i32
}

fn bump(value: i32) -> i32
  value + 1

pub fn main() -> i32
  (Vec2 { x: bump(1), y: bump(2) }).y
`,
      },
    });

    const candidates =
      optimized.facts.semanticCopyForwardingFieldAccesses.get("src::main");
    expect(candidates?.size).toBe(1);

    const codegen = codegenProgram({
      program: optimized.program,
      entryModuleId,
      optimization: optimized.facts,
      options: {
        optimize: false,
        validate: false,
        runtimeDiagnostics: false,
      },
    });
    expect(codegen.diagnostics).toHaveLength(0);
  });
});
