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
    expect(candidateOccurrences).toHaveLength(0);
  });

  it("reports missing labeled trait-call arguments directly", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const host = createMemoryHost({
      [entryPath]: `
use src::hit::{ Hittable, HitRecord }

fn probe(world: Hittable, ray: i32) -> bool
  let ~rec = HitRecord()
  world.hit({ ray, ray_tmin: 0, ray_tmax: 1 })

pub fn main() -> i32
  0
`,
      [`${root}${sep}hit.voyd`]: `
pub obj HitRecord {
  t: i32
}

impl HitRecord
  fn init()
    HitRecord { t: 0 }

pub trait Hittable
  fn hit(self, { ray: i32, ray_tmin: i32, ray_tmax: i32, ~rec: HitRecord }) -> bool

obj Dummy {}

impl Hittable for Dummy
  fn hit(self, { ray: i32, ray_tmin: i32, ray_tmax: i32, ~rec: HitRecord }) -> bool
    true
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    expect(result.diagnostics.some((entry) => entry.code === "TY9999")).toBe(false);

    const diagnostic = result.diagnostics.find((entry) => entry.code === "TY0021");
    expect(diagnostic).toBeDefined();
    if (!diagnostic) {
      return;
    }

    expect(diagnostic.message).toContain("missing required labeled call argument rec");
    expect(result.diagnostics.some((entry) => entry.code === "TY0008")).toBe(false);
  });

  it("does not crash when method fallback considers imported free functions", async () => {
    const root = resolve("/proj/src");
    const entryPath = `${root}${sep}pkg.voyd`;
    const localPrelude = Array.from(
      { length: 80 },
      (_, index) => `
fn local_${index}() -> i32
  ${index}
`,
    ).join("\n");
    const host = createMemoryHost({
      [entryPath]: `
${localPrelude}

use src::dep::foo

obj Box {}

impl Box
  fn foo(self, { value: i32 }) -> i32
    value

fn probe(box: Box) -> i32
  box.foo(1)

pub fn main() -> i32
  0
`,
      [`${root}${sep}dep.voyd`]: `
pub fn foo(value: i32) -> i32
  value
`,
    });

    const result = expectCompileFailure(
      await compileProgram({
        entryPath,
        roots: { src: root },
        host,
      }),
    );

    expect(result.diagnostics.some((entry) => entry.code === "TY9999")).toBe(false);
    expect(result.diagnostics.some((entry) => entry.code === "TY0008")).toBe(true);
  });
});
