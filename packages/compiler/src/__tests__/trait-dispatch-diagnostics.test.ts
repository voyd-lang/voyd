import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import { compileProgram, type CompileProgramResult } from "../pipeline.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const expectCompileFailure = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: false }> => {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("expected compile failure");
  }
  return result;
};

describe("trait dispatch diagnostics", () => {
  it("reports trait method argument mismatches without duplicate candidates", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `
use src::hit::Hittable
use src::utils::INFINITY

fn probe(world: Hittable) -> bool
  world.hit({ value: INFINITY })

pub fn main() -> i32
  0
`,
      [`${root}${sep}hit.voyd`]: `
pub trait Hittable
  fn hit(self, { value: f64 }) -> bool

obj HittableList {}

impl Hittable for HittableList
  fn hit(self, { value: f64 }) -> bool
    true
`,
      [`${root}${sep}utils.voyd`]: `
pub let INFINITY = 1 / 0
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );
    const diagnostic = result.diagnostics.find((entry) => entry.code === "TY0008");
    expect(diagnostic).toBeDefined();
    if (!diagnostic) {
      return;
    }

    expect(diagnostic.message).toContain(
      "type incompatibility at argument 2: expected f64, got i32",
    );
    expect(diagnostic.message).toContain("hit(self: trait Hittable, value: f64)");

    const candidateOccurrences =
      diagnostic.message.match(/- hit\(self: object HittableList/g) ?? [];
    expect(candidateOccurrences).toHaveLength(1);
  });
});
