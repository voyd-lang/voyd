import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { monomorphizeProgram } from "../../semantics/linking.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { optimizeProgram } from "../../optimize/pipeline.js";
import { codegenProgram } from "../index.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";

const compileOptimized = (source: string) => {
  const ast = parse(source, "scalar_aggregate_replacement.voyd");
  const moduleNode: ModuleNode = {
    id: "std::scalar_aggregate_replacement",
    path: { namespace: "std", segments: ["scalar_aggregate_replacement"] },
    origin: {
      kind: "file",
      filePath: "scalar_aggregate_replacement.voyd",
    },
    ast,
    source,
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: moduleNode.id,
    modules: new Map([[moduleNode.id, moduleNode]]),
    diagnostics: [],
  };
  const semantics = semanticsPipeline({ module: moduleNode, graph });
  const semanticsByModule = new Map([[moduleNode.id, semantics]]);
  const monomorphized = monomorphizeProgram({
    modules: [semantics],
    semantics: semanticsByModule,
  });
  const program = buildProgramCodegenView([semantics], {
    instances: monomorphized.instances,
    moduleTyping: monomorphized.moduleTyping,
  });
  const optimized = optimizeProgram({
    program,
    modules: [semantics],
    entryModuleId: moduleNode.id,
  });
  const optimizedCodegen = codegenProgram({
    program: optimized.program,
    entryModuleId: moduleNode.id,
    optimization: optimized.facts,
    options: { validate: false },
  });
  const baselineCodegen = codegenProgram({
    program: optimized.program,
    entryModuleId: moduleNode.id,
    options: { validate: false },
  });
  if (optimizedCodegen.diagnostics.length > 0) {
    throw new Error(JSON.stringify(optimizedCodegen.diagnostics, null, 2));
  }
  if (baselineCodegen.diagnostics.length > 0) {
    throw new Error(JSON.stringify(baselineCodegen.diagnostics, null, 2));
  }
  return { optimized, optimizedCodegen, baselineCodegen };
};

const runMain = (
  module: ReturnType<typeof compileOptimized>["optimizedCodegen"]["module"],
) => {
  const instance = getWasmInstance(module);
  return instance.exports.main as () => number;
};

describe("scalar aggregate replacement", () => {
  it("passes scalarized arrays to optional parameters", () => {
    const { optimizedCodegen, baselineCodegen } = compileOptimized(`
obj Array<T> { storage: FixedArray<T>, count: i32 }
obj Some<T> { value: T }
obj None {}
type Optional<T> = Some<T> | None

pub fn new_array_unchecked<T>({ from source: FixedArray<T> }) -> Array<T>
  Array<T> { storage: source, count: __array_len(source) }

impl<T> Array<T>
  fn len(self) -> i32
    self.count

fn count(values?: Array<i32>) -> i32
  if values is Some:
    return values.value.len()
  0

pub fn main() -> i32
  let values = [7]
  count(values) * 10 + count()
`);

    expect(runMain(optimizedCodegen.module)()).toBe(10);
    expect(runMain(baselineCodegen.module)()).toBe(10);
  });

  it("keeps receiver variants distinct when aggregate arguments are present", () => {
    const { optimizedCodegen } = compileOptimized(`
trait Runner
  fn adjust(self, value: i32) -> i32

obj Box {}
obj Alt {}
obj Vec2 { x: i32, y: i32 }

impl Runner for Box
  fn adjust(self, value: i32) -> i32
    value

impl Runner for Alt
  fn adjust(self, value: i32) -> i32
    value + 100

fn helper(runner: Runner, vec: Vec2) -> i32
  runner.adjust(vec.x + vec.y)

pub fn main() -> i32
  helper(Box {}, Vec2 { x: 1, y: 2 }) +
    helper(Alt {}, Vec2 { x: 3, y: 4 })
`);

    expect(runMain(optimizedCodegen.module)()).toBe(110);
    const wasmText = optimizedCodegen.module.emitText();
    const specializedHelpers = Array.from(
      wasmText.matchAll(/\(func \$[^\s]*helper[^\s]*__receiver_[^\s(]*/g),
    );
    expect(specializedHelpers).toHaveLength(2);
  });

  it("keeps non-escaping object literal fields in scalar locals", () => {
    const { optimized, optimizedCodegen, baselineCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

fn bump(value: i32) -> i32
  value + 1

pub fn main() -> i32
  let vec = Vec2 { x: bump(1), y: bump(2) }
  vec.x + vec.y
`);

    const originFacts = optimized.facts.escapeAnalysis.origins.get(
      "std::scalar_aggregate_replacement",
    );
    expect(
      [...(originFacts?.values() ?? [])].some((fact) => !fact.escapes),
    ).toBe(true);
    expect(runMain(optimizedCodegen.module)()).toBe(5);

    const optimizedText = optimizedCodegen.module.emitText();
    const baselineText = baselineCodegen.module.emitText();
    expect(baselineText).toMatch(/\(struct\.new \$voyd_struct_shape_/);
    expect(optimizedText).not.toMatch(/\(struct\.new \$voyd_struct_shape_/);
  });

  it("rematerializes object literals at return escape boundaries", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

fn make_vec() -> Vec2
  let vec = Vec2 { x: 4, y: 5 }
  vec

pub fn main() -> i32
  let vec = make_vec()
  vec.x + vec.y
`);

    expect(runMain(optimizedCodegen.module)()).toBe(9);
    expect(optimizedCodegen.module.emitText()).toMatch(
      /\(struct\.new \$voyd_struct_shape_/,
    );
  });

  it("keeps return-escaping mutable locals scalar until return materialization", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

fn make_vec() -> Vec2
  let ~vec = Vec2 { x: 4, y: 5 }
  vec.x = vec.x + 1
  vec

pub fn main() -> i32
  let vec = make_vec()
  vec.x + vec.y
`);

    const optimizedText = optimizedCodegen.module.emitText();
    const makeVecStart = optimizedText.indexOf(
      "(func $std__scalar_aggregate_replacement__make_vec_",
    );
    expect(makeVecStart).toBeGreaterThanOrEqual(0);
    const nextFuncStart = optimizedText.indexOf("\n (func ", makeVecStart + 1);
    const makeVecText = optimizedText.slice(makeVecStart, nextFuncStart);
    expect(runMain(optimizedCodegen.module)()).toBe(10);
    expect(makeVecText).toMatch(/\(struct\.new \$voyd_struct_shape_/);
    expect(makeVecText).not.toMatch(/\(struct\.set \$voyd_struct_shape_/);
  });

  it("updates non-escaping mutable aggregate fields without materializing", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

pub fn main() -> i32
  let ~vec = Vec2 { x: 1, y: 2 }
  vec.x = vec.x + 10
  vec.x + vec.y
`);

    expect(runMain(optimizedCodegen.module)()).toBe(13);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /\(struct\.new \$voyd_struct_shape_/,
    );
  });

  it("preserves mutable value-object locals passed by mutable reference", () => {
    const { optimizedCodegen, baselineCodegen } = compileOptimized(`
pub val Vec3 {
  x: i32,
  y: i32,
  z: i32
}

impl Vec3
  fn empty() -> Vec3
    Vec3 { x: 0, y: 0, z: 0 }

fn fill(~out: Vec3) -> bool
  out.x = 1
  out.y = 2
  out.z = 3
  true

pub fn main() -> i32
  let ~out = Vec3::empty()
  if fill(out):
    return out.x + out.y + out.z
  0
`);

    expect(runMain(baselineCodegen.module)()).toBe(6);
    expect(runMain(optimizedCodegen.module)()).toBe(6);
  });

  it("preserves multiple mutable value-object call outputs after value arguments", () => {
    const { optimizedCodegen, baselineCodegen } = compileOptimized(`
pub val Vec3 {
  x: i32,
  y: i32,
  z: i32
}

pub val Ray {
  origin: Vec3,
  direction: Vec3
}

impl Vec3
  fn empty() -> Vec3
    Vec3 { x: 0, y: 0, z: 0 }

  fn '*'(self, other: Vec3) -> Vec3
    Vec3 { x: self.x * other.x, y: self.y * other.y, z: self.z * other.z }

  fn apply(~self, vec: Vec3)
    self.x = vec.x
    self.y = vec.y
    self.z = vec.z

impl Ray
  fn empty() -> Ray
    Ray { origin: Vec3::empty(), direction: Vec3::empty() }

fn fill(ray: Ray, ~out: Vec3, ~scattered: Ray) -> bool
  out.apply(Vec3 { x: 1, y: 2, z: 3 })
  scattered.direction.x = ray.origin.x + 4
  true

fn color(ray: Ray, depth: i32) -> Vec3
  if depth <= 0:
    return Vec3 { x: 1, y: 1, z: 1 }

  let ~out = Vec3::empty()
  let ~scattered = Ray::empty()
  if fill(ray, out, scattered):
    return out * color(scattered, depth - 1)

  Vec3::empty()

pub fn main() -> i32
  let ray = Ray { origin: Vec3 { x: 5, y: 0, z: 0 }, direction: Vec3::empty() }
  let result = color(ray, 1)
  result.x + result.y + result.z
`);

    expect(runMain(baselineCodegen.module)()).toBe(6);
    expect(runMain(optimizedCodegen.module)()).toBe(6);
  });

  it("materializes scalar heap roots before nested value field mutation", () => {
    const { optimizedCodegen } = compileOptimized(`
type Inner = { x: i32, y: i32 }

obj Outer {
  inner: Inner
}

pub fn main() -> i32
  let ~outer = Outer { inner: { x: 1, y: 5 } }
  outer.inner.x = 10
  outer.inner.x + outer.inner.y
`);

    expect(runMain(optimizedCodegen.module)()).toBe(15);
  });

  it("keeps conditional aggregate branch values in scalar locals", () => {
    const { optimizedCodegen, baselineCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

pub fn main() -> i32
  let flag = true
  let vec = if flag then: Vec2 { x: 1, y: 2 } else: Vec2 { x: 10, y: 20 }
  vec.x + vec.y
`);

    expect(runMain(optimizedCodegen.module)()).toBe(3);
    expect(baselineCodegen.module.emitText()).toMatch(
      /\(struct\.new \$voyd_struct_shape_/,
    );
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /\(struct\.new \$voyd_struct_shape_/,
    );
  });

  it("compiles scalar block initializer statements before the block value", () => {
    const { optimizedCodegen } = compileOptimized(`
pub val Vec2 {
  x: i32,
  y: i32
}

pub fn main() -> i32
  let vec = block
    let x = 1
    Vec2 { x: x, y: 2 }
  vec.x + vec.y
`);

    expect(runMain(optimizedCodegen.module)()).toBe(3);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /\(struct\.new \$voyd_struct_shape_/,
    );
  });

  it("stores small value-object call returns into scalar field locals", () => {
    const { optimizedCodegen } = compileOptimized(`
pub val Vec3 {
  x: i32,
  y: i32,
  z: i32
}

fn make_vec(seed: i32) -> Vec3
  Vec3 { x: seed, y: seed + 1, z: seed + 2 }

pub fn main() -> i32
  let vec = make_vec(4)
  vec.x + vec.y + vec.z
`);

    expect(runMain(optimizedCodegen.module)()).toBe(15);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /\(struct\.new \$voyd_struct_shape_/,
    );
  });

  it("returns direct heap-object factory results as scalar lanes for local use", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

fn make_vec() -> Vec2
  Vec2 { x: 4, y: 5 }

pub fn main() -> i32
  let vec = make_vec()
  vec.x + vec.y
`);

    const optimizedText = optimizedCodegen.module.emitText();
    const specializedStart = optimizedText.indexOf("__scalar_agg__result");
    expect(runMain(optimizedCodegen.module)()).toBe(9);
    expect(specializedStart).toBeGreaterThanOrEqual(0);
    const specializedFuncStart = optimizedText.lastIndexOf(
      "(func ",
      specializedStart,
    );
    const specializedFuncEnd = optimizedText.indexOf(
      "\n (func ",
      specializedStart,
    );
    const specializedText = optimizedText.slice(
      specializedFuncStart,
      specializedFuncEnd,
    );
    expect(specializedText).not.toMatch(/\(struct\.new \$voyd_struct_shape_/);
  });

  it("does not scalarize heap-object call returns that may alias existing objects", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

fn id(box: Box) -> Box
  box

pub fn main() -> i32
  let ~a = Box { value: 1 }
  let b = id(a)
  b.value + a.value
`);

    expect(runMain(optimizedCodegen.module)()).toBe(2);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /__scalar_agg__result/,
    );
  });

  it("materializes scalar heap-object locals before alias initialization", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

pub fn main() -> i32
  let ~a = Box { value: 1 }
  let ~b = a
  b.value = 2
  a.value
`);

    expect(runMain(optimizedCodegen.module)()).toBe(2);
  });

  it("keeps statementful heap-object factory returns on the public ABI", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

fn make_box(seed: i32) -> Box
  let value = seed + 1
  Box { value: value }

pub fn main() -> i32
  let box = make_box(3)
  box.value
`);

    expect(runMain(optimizedCodegen.module)()).toBe(4);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /__scalar_agg__result/,
    );
  });

  it("does not scalarize heap-object call returns through aliasing wrappers", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

fn id(box: Box) -> Box
  box

fn wrap(box: Box) -> Box
  id(box)

pub fn main() -> i32
  let ~a = Box { value: 1 }
  let b = wrap(a)
  b.value + a.value
`);

    expect(runMain(optimizedCodegen.module)()).toBe(2);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /__scalar_agg__result/,
    );
  });

  it("does not force scalar call arguments from non-fresh heap-object calls", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

fn id(box: Box) -> Box
  box

fn read(box: Box) -> i32
  box.value

pub fn main() -> i32
  read(id(Box { value: 5 }))
`);

    expect(runMain(optimizedCodegen.module)()).toBe(5);
  });

  it("does not scalarize heap-object parameters mutated by the callee", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

fn set_value(~box: Box) -> void
  box.value = 9

pub fn main() -> i32
  let ~box = Box { value: 1 }
  set_value(box)
  box.value
`);

    expect(runMain(optimizedCodegen.module)()).toBe(9);
  });

  it("does not scalarize heap-object parameters mutated through local aliases", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

fn mutate_alias(~box: Box) -> i32
  let ~alias = box
  alias.value = 7
  box.value

pub fn main() -> i32
  let ~box = Box { value: 1 }
  mutate_alias(box) * 10 + box.value
`);

    expect(runMain(optimizedCodegen.module)()).toBe(77);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /mutate_alias[\s\S]*__scalar_agg__param/,
    );
  });

  it("reads current materialized values for later scalar call arguments", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

fn mutate_alias(~box: Box) -> i32
  let ~alias = box
  alias.value = 20
  box.value

fn combine(value: i32, box: Box) -> i32
  value + box.value

pub fn main() -> i32
  let ~box = Box { value: 1 }
  combine(mutate_alias(box), box)
`);

    expect(runMain(optimizedCodegen.module)()).toBe(40);
  });

  it("does not leak branch-local scalar alias materialization", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

pub fn main() -> i32
  let ~box = Box { value: 1 }
  if false:
    let ~alias = box
    alias.value = 9
  box.value
`);

    expect(runMain(optimizedCodegen.module)()).toBe(1);
  });

  it("preserves branch alias mutations after the branch", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

pub fn main() -> i32
  let ~box = Box { value: 1 }
  if true:
    let ~alias = box
    alias.value = 9
  else:
    let ~alias = box
    alias.value = 5
  box.value
`);

    expect(runMain(optimizedCodegen.module)()).toBe(9);
  });

  it("preserves branch nested field mutations after the branch", () => {
    const { optimizedCodegen } = compileOptimized(`
type Inner = { x: i32, y: i32 }

obj Outer {
  inner: Inner
}

pub fn main() -> i32
  let ~outer = Outer { inner: { x: 1, y: 2 } }
  if true:
    outer.inner.x = 9
  else:
    outer.inner.x = 5
  outer.inner.x + outer.inner.y
`);

    expect(runMain(optimizedCodegen.module)()).toBe(11);
  });

  it("preserves branch nested value-object mutations after the branch", () => {
    const { optimizedCodegen } = compileOptimized(`
pub val Inner {
  x: i32,
  y: i32
}

pub val Outer {
  inner: Inner
}

pub fn main() -> i32
  let flag = true
  let ~outer = Outer { inner: Inner { x: 1, y: 2 } }
  if flag:
    outer.inner.x = 9
  else:
    outer.inner.x = 5
  outer.inner.x + outer.inner.y
`);

    expect(runMain(optimizedCodegen.module)()).toBe(11);
  });

  it("does not leak narrowed match discriminant bindings", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Dog {
  noses: i32
}

obj Cat {
  lives: i32
}

type Pet = Dog | Cat

pub fn main() -> i32
  let pet: Pet = Cat { lives: 4 }
  let first = match(pet)
    Dog: 1
    Cat: 2
  let second = match(pet)
    Dog: 10
    Cat: pet.lives + 20
  first + second
`);

    expect(runMain(optimizedCodegen.module)()).toBe(26);
  });

  it("destructures scalar aggregate locals without rematerializing", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

pub fn main() -> i32
  let vec = Vec2 { x: 4, y: 6 }
  let { x, y } = vec
  x + y
`);

    expect(runMain(optimizedCodegen.module)()).toBe(10);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /\(struct\.new \$voyd_struct_shape_/,
    );
  });

  it("passes scalarized heap-object locals to non-escaping direct calls as lanes", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

fn sum_vec(vec: Vec2) -> i32
  vec.x + vec.y

pub fn main() -> i32
  let vec = Vec2 { x: 7, y: 8 }
  sum_vec(vec)
`);

    expect(runMain(optimizedCodegen.module)()).toBe(15);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /\(struct\.new \$voyd_struct_shape_/,
    );
  });

  it("passes direct heap-object literals to non-escaping direct calls as lanes", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

fn sum_vec(vec: Vec2) -> i32
  vec.x + vec.y

pub fn main() -> i32
  sum_vec(Vec2 { x: 7, y: 8 })
`);

    expect(runMain(optimizedCodegen.module)()).toBe(15);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /\(struct\.new \$voyd_struct_shape_/,
    );
  });

  it("preserves call argument side-effect order for scalar aggregate lanes", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

obj Vec2 {
  x: i32,
  y: i32
}

fn mutate_and_read(~box: Box) -> i32
  box.value = 10
  box.value

fn combine(value: i32, vec: Vec2) -> i32
  value + vec.x + vec.y

pub fn main() -> i32
  let ~box = Box { value: 1 }
  combine(mutate_and_read(box), Vec2 { x: box.value, y: 0 })
`);

    expect(runMain(optimizedCodegen.module)()).toBe(20);
  });

  it("keeps scalar object-literal call argument setup with the override", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

pub val Vec2 {
  x: i32,
  y: i32
}

fn mutate_alias(~box: Box) -> i32
  let ~alias = box
  alias.value = 20
  box.value

fn consume(vec: Vec2) -> i32
  vec.x + vec.y

pub fn main() -> i32
  let ~box = Box { value: 1 }
  consume(Vec2 { x: mutate_alias(box), y: box.value })
`);

    expect(runMain(optimizedCodegen.module)()).toBe(40);
  });

  it("preserves block statements when heap-object call arguments fall back", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

fn sum_vec(vec: Vec2) -> i32
  vec.x + vec.y

pub fn main() -> i32
  var marker = 0
  let result = sum_vec(block
    marker = 5
    Vec2 { x: 1, y: 2 })
  result + marker
`);

    expect(runMain(optimizedCodegen.module)()).toBe(8);
  });

  it("keeps effectful heap-object callees on the normal ABI", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

eff Local
  next(tail) -> i32

fn sum_vec(vec: Vec2): Local -> i32
  vec.x + vec.y + Local::next()

pub fn main(): () -> i32
  try
    let vec = Vec2 { x: 1, y: 2 }
    sum_vec(vec)
  Local::next(tail):
    tail(4)
`);

    expect(runMain(optimizedCodegen.module)()).toBe(7);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /__scalar_agg__param/,
    );
  });

  it("restores bindings after failed scalar heap-result probing", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Box {
  value: i32
}

fn mutate_alias_return(~box: Box) -> Box
  let ~alias = box
  alias.value = 7
  let value = 2
  Box { value: value }

pub fn main() -> i32
  let ~box = Box { value: 1 }
  let other = mutate_alias_return(box)
  other.value * 10 + box.value
`);

    expect(runMain(optimizedCodegen.module)()).toBe(27);
  });

  it("preserves block statements when scalar aggregate reassignments fall back", () => {
    const { optimizedCodegen } = compileOptimized(`
pub val Vec2 {
  x: i32,
  y: i32
}

pub fn main() -> i32
  var marker = 0
  var vec = Vec2 { x: 1, y: 1 }
  vec = block
    marker = 5
    Vec2 { x: 3, y: 4 }
  vec.x + vec.y + marker
`);

    expect(runMain(optimizedCodegen.module)()).toBe(12);
  });

  it("reassigns mutable scalar value aggregate locals without materializing", () => {
    const { optimizedCodegen } = compileOptimized(`
pub val Vec2 {
  x: i32,
  y: i32
}

pub fn main() -> i32
  var vec = Vec2 { x: 1, y: 2 }
  vec = Vec2 { x: 5, y: 6 }
  vec.x + vec.y
`);

    expect(runMain(optimizedCodegen.module)()).toBe(11);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /\(struct\.new \$voyd_struct_shape_/,
    );
  });

  it("extracts labeled call arguments from scalar aggregate locals", () => {
    const { optimizedCodegen } = compileOptimized(`
obj Vec2 {
  x: i32,
  y: i32
}

fn sum_vec({ x: i32, y: i32 }) -> i32
  x + y

pub fn main() -> i32
  let vec = Vec2 { x: 4, y: 6 }
  sum_vec(vec)
`);

    expect(runMain(optimizedCodegen.module)()).toBe(10);
    expect(optimizedCodegen.module.emitText()).not.toMatch(
      /\(struct\.new \$voyd_struct_shape_/,
    );
  });
});
