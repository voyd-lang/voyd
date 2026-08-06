import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { monomorphizeProgram } from "../../semantics/linking.js";
import { buildProgramCodegenView } from "../../semantics/codegen-view/index.js";
import { optimizeProgram } from "../../optimize/pipeline.js";
import { codegenProgram } from "../index.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";

const compile = (source: string) => {
  const ast = parse(source, "stable_field_load_forwarding.voyd");
  const moduleNode: ModuleNode = {
    id: "std::stable_field_load_forwarding",
    path: { namespace: "std", segments: ["stable_field_load_forwarding"] },
    origin: { kind: "file", filePath: "stable_field_load_forwarding.voyd" },
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
  const generated = codegenProgram({
    program: optimized.program,
    entryModuleId: moduleNode.id,
    optimization: optimized.facts,
    options: { validate: true },
  });
  const baseline = codegenProgram({
    program: optimized.program,
    entryModuleId: moduleNode.id,
    options: { validate: true },
  });
  if (generated.diagnostics.length > 0) {
    throw new Error(JSON.stringify(generated.diagnostics, null, 2));
  }
  return { optimized, generated, baseline, moduleId: moduleNode.id };
};

const source = ({ mutation }: { mutation: "sibling" | "same" | "root" }) => `
obj Record { stable: i32, changing: i32 }

fn bump(~value: Record) -> void
  ${
    mutation === "sibling"
      ? "value.changing = value.changing + 1"
      : mutation === "same"
        ? "value.stable = value.stable + 1"
        : "value = Record { stable: 9, changing: 0 }"
  }

pub fn main() -> i32
  let ~value = Record { stable: 3, changing: 0 }
  let alias = value
  var iteration = 0
  var total = 0
  while iteration < 10:
    total = total + alias.stable
    bump(~value)
    total = total + alias.stable
    iteration = iteration + 1
  total + value.changing
`;

describe("stable field load forwarding", () => {
  it("forwards a fixed field load across a resolved disjoint call", () => {
    const { optimized, generated, baseline, moduleId } = compile(
      source({ mutation: "sibling" }),
    );
    const instance = getWasmInstance(generated.module);
    expect((instance.exports.main as () => number)()).toBe(70);
    expect(optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size).toBe(
      1,
    );
    const structGets = (text: string) =>
      Array.from(text.matchAll(/\(struct\.get\b/g)).length;
    expect(structGets(generated.module.emitText())).toBeLessThan(
      structGets(baseline.module.emitText()),
    );
  });

  it.each(["same", "root"] as const)(
    "does not forward across a %s write",
    (mutation) => {
      const { optimized, moduleId } = compile(source({ mutation }));
      expect(
        optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size ?? 0,
      ).toBe(0);
    },
  );

  it("bails out when a prior call returns provenance from the candidate root", () => {
    const { optimized, moduleId } = compile(`
obj Record { stable: i32, changing: i32 }
obj Saved { value: Record }

fn save(value: Record) -> Saved
  Saved { value }

fn bump(~value: Record) -> void
  value.changing = value.changing + 1

pub fn main() -> i32
  let ~value = Record { stable: 3, changing: 0 }
  let alias = value
  let saved = save(value)
  var iteration = 0
  var total = 0
  while iteration < 10:
    total = total + alias.stable
    bump(~value)
    total = total + alias.stable
    iteration = iteration + 1
  total + saved.value.changing
`);
    expect(
      optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size ?? 0,
    ).toBe(0);
  });

  it("bails out for dynamic method dispatch", () => {
    const { optimized, moduleId } = compile(`
obj Record { stable: i32, changing: i32 }
trait Mutator
  fn bump(self, ~value: Record) -> void

obj Increment {}
impl Mutator for Increment
  fn bump(self, ~value: Record) -> void
    value.changing = value.changing + 1

fn run(mutator: Mutator) -> i32
  let ~value = Record { stable: 3, changing: 0 }
  let alias = value
  var iteration = 0
  var total = 0
  while iteration < 10:
    total = total + alias.stable
    mutator.bump(~value)
    total = total + alias.stable
    iteration = iteration + 1
  total

pub fn main() -> i32
  run(Increment {})
`);
    expect(
      optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size ?? 0,
    ).toBe(0);
  });

  it("bails out for an unresolved function-value call", () => {
    const { optimized, moduleId } = compile(`
obj Record { stable: i32, changing: i32 }

fn run(callback: fn(~Record) : () -> void) -> i32
  let ~value = Record { stable: 3, changing: 0 }
  let alias = value
  var iteration = 0
  var total = 0
  while iteration < 10:
    total = total + alias.stable
    callback(~value)
    total = total + alias.stable
    iteration = iteration + 1
  total

pub fn main() -> i32
  run((~value) => value.changing = value.changing + 1)
`);
    expect(
      optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size ?? 0,
    ).toBe(0);
  });

  it("does not plan forwarding for indexed field paths", () => {
    const { optimized, moduleId } = compile(`
obj Record { stable: i32, changing: i32 }

fn new_array_unchecked<T>({ from source: FixedArray<T> }) -> FixedArray<T>
  source

pub fn main() -> i32
  let values = [Record { stable: 3, changing: 0 }]
  var iteration = 0
  var total = 0
  while iteration < 10:
    total = total + __array_get(values, 0).stable
    total = total + __array_get(values, 0).stable
    iteration = iteration + 1
  total
`);
    expect(
      optimized.facts.stableFieldLoadForwarding.get(moduleId)?.size ?? 0,
    ).toBe(0);
  });
});
