import { describe, expect, it } from "vitest";
import { resolve, sep } from "node:path";
import {
  compileProgram,
  emitProgram,
  type CompileProgramResult,
} from "../pipeline.js";
import { createMemoryModuleHost } from "../modules/memory-host.js";
import { createNodePathAdapter } from "../modules/node-path-adapter.js";
import type { ModuleHost } from "../modules/types.js";
import { getWasmInstance } from "@voyd-lang/lib/wasm.js";
import { codegenProgram } from "../codegen/index.js";
import { RUNTIME_DIAGNOSTICS_SECTION } from "../codegen/exports/runtime-diagnostics.js";
import { wasmBufferSource } from "../codegen/__tests__/support/wasm-utils.js";
import { buildProgramCodegenView } from "../semantics/codegen-view/index.js";
import { monomorphizeProgram } from "../semantics/linking.js";

const createMemoryHost = (files: Record<string, string>): ModuleHost =>
  createMemoryModuleHost({ files, pathAdapter: createNodePathAdapter() });

const expectCompileSuccess = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: true }> => {
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  expect(result.success).toBe(true);
  return result;
};

describe("functional macros across modules", () => {
  it("expands pub macros from sibling modules", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const macrosPath = `${root}${sep}macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::macros::all

pub fn main() -> f64
  inc(2.0)
`,
      [macrosPath]: `
pub macro inc(value)
  syntax_template (+ $value 1.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("expands pub macros from pkg modules", async () => {
    const appRoot = resolve("/proj/app");
    const pkgRoot = resolve("/proj/pkg");
    const mainPath = `${appRoot}${sep}main.voyd`;
    const pkgPath = `${pkgRoot}${sep}macro_lib${sep}pkg.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use pkg::macro_lib::all

pub fn main() -> f64
  add_two(5.0)
`,
      [pkgPath]: `
pub macro add_two(value)
  syntax_template (+ $value 2.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: appRoot, pkg: pkgRoot },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(7);
  });

  it("re-exports pub macros via pub use", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const basePath = `${root}${sep}base_macros.voyd`;
    const reexportPath = `${root}${sep}macro_exports.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::macro_exports::all

pub fn main() -> f64
  inc(2.0)
`,
      [basePath]: `
pub macro inc(value)
  syntax_template (+ $value 1.0)
`,
      [reexportPath]: `
pub use src::base_macros::all
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("re-exports pub macros via bare pub module-expression", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const basePath = `${root}${sep}base_macros.voyd`;
    const reexportPath = `${root}${sep}macro_exports.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::macro_exports::all

pub fn main() -> f64
  inc(2.0)
`,
      [basePath]: `
pub macro inc(value)
  syntax_template (+ $value 1.0)
`,
      [reexportPath]: `
pub src::base_macros::all
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("imports a macro through a public ordinary module in an installed package", async () => {
    const root = resolve("/proj/src");
    const pkgDir = resolve("/proj/node_modules");
    const packageRoot = `${pkgDir}${sep}macros${sep}src`;
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use pkg::macros::dsl::serve
use pkg::macros::dsl::{ serve as serve_alias }

pub fn main() -> f64
  serve(40.0) + serve_alias(1.0)
`,
      [`${packageRoot}${sep}pkg.voyd`]: `
pub src::dsl
pub use src::dsl::serve
`,
      [`${packageRoot}${sep}dsl.voyd`]: `
pub macro serve(value)
  syntax_template (+ $value 1.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root, pkgDirs: [pkgDir] },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(43);
  });

  it("keeps definition-site helper references in a public ordinary macro module", async () => {
    const root = resolve("/proj/src");
    const pkgDir = resolve("/proj/node_modules");
    const packageRoot = `${pkgDir}${sep}macros${sep}src`;
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use pkg::macros::dsl::serve

pub fn main() -> i32
  serve(2)
`,
      [`${packageRoot}${sep}pkg.voyd`]: `
pub src::dsl
pub use src::dsl::serve
`,
      [`${packageRoot}${sep}dsl.voyd`]: `
use super::helpers::helper

pub macro serve(value)
  let helper_ref = symbol_reference(helper)
  \`($helper_ref $value)
`,
      [`${packageRoot}${sep}helpers.voyd`]: `
pub fn helper(value: i32) -> i32
  value + 40
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root, pkgDirs: [pkgDir] },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("keeps macros in non-exported modules and non-pub macros hidden", async () => {
    const root = resolve("/proj/src");
    const pkgDir = resolve("/proj/node_modules");
    const packageRoot = `${pkgDir}${sep}macros${sep}src`;
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use pkg::macros::dsl::internal
use pkg::macros::private::hidden
`,
      [`${packageRoot}${sep}pkg.voyd`]: `
pub src::dsl
pub use src::dsl::serve
`,
      [`${packageRoot}${sep}dsl.voyd`]: `
pub macro serve(value)
  syntax_template (+ $value 1.0)

macro internal(value)
  syntax_template (+ $value 1.0)
`,
      [`${packageRoot}${sep}private.voyd`]: `
pub macro hidden(value)
  syntax_template (+ $value 1.0)
`,
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root, pkgDirs: [pkgDir] },
      host,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected hidden macros to fail compilation");
    }
    const messages = result.diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toContainEqual(expect.stringContaining("Macro internal"));
    expect(messages).toContainEqual(
      expect.stringContaining("Cannot import hidden"),
    );
  });

  it("preserves inline pkg scope when re-exporting macros from nested pkg.voyd", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const nestedPkgPath = `${root}${sep}pkgs${sep}arith${sep}pkg.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::pkgs::arith::pkg::all

pub fn main() -> f64
  add_one(41.0)
`,
      [nestedPkgPath]: `
mod macros
  pub macro add_one(value)
    syntax_template (+ $value 1.0)

pub use self::macros::all
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("re-expands modules after generated imports load macros", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const macrosPath = `${root}${sep}generated_macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
macro import_generated_macros()
  syntax_template (use src::generated_macros::all)

import_generated_macros()
declare_helper(helper)

pub fn main() -> f64
  helper()
`,
      [macrosPath]: `
pub macro declare_helper(name)
  syntax_template (fn $name() -> f64
    42.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("re-expands importers when generated re-exports add macros", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const brokerPath = `${root}${sep}broker.voyd`;
    const macrosPath = `${root}${sep}generated_macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::broker::all

declare_helper(helper)

pub fn main() -> f64
  helper()
`,
      [brokerPath]: `
macro import_generated_macros()
  syntax_template (pub use src::generated_macros::all)

import_generated_macros()
`,
      [macrosPath]: `
pub macro declare_helper(name)
  syntax_template (fn $name() -> f64
    42.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("rebuilds exported macro scopes after generated imports load", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const brokerPath = `${root}${sep}broker.voyd`;
    const macrosPath = `${root}${sep}generated_macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::broker::all

declare_helper(helper)

pub fn main() -> f64
  helper()
`,
      [brokerPath]: `
macro import_generated_macros()
  syntax_template (use src::generated_macros::all)

import_generated_macros()

pub macro declare_helper(name)
  answer(name)
`,
      [macrosPath]: `
pub macro answer(name)
  syntax_template (fn $name() -> f64
    42.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("resolves generated pkg self uses against generated inline modules", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const pkgPath = `${root}${sep}pkgs${sep}arith${sep}pkg.voyd`;
    const macrosPath = `${root}${sep}generated_macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::pkgs::arith::pkg::all

declare_helper(helper)

pub fn main() -> f64
  helper()
`,
      [pkgPath]: `
macro declare_macros_module()
  emit_many(
    \`(mod macros (block (pub use src::generated_macros::all))),
    \`(pub use self::macros::all)
  )

declare_macros_module()
`,
      [macrosPath]: `
pub macro declare_helper(name)
  syntax_template (fn $name() -> f64
    42.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("re-expands when a generated use changes visibility", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const brokerPath = `${root}${sep}broker.voyd`;
    const macrosPath = `${root}${sep}generated_macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::broker::all

declare_helper(helper)

pub fn main() -> f64
  helper()
`,
      [brokerPath]: `
use src::generated_macros::all

macro export_generated_macros()
  syntax_template (pub use src::generated_macros::all)

export_generated_macros()
`,
      [macrosPath]: `
pub macro declare_helper(name)
  syntax_template (fn $name() -> f64
    42.0)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("preserves literal numeric types when splicing macro arguments", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
obj Some {
  value: i32
}

obj None {}

type Optional = Some | None

fn some(v: i32): () -> Optional
  Some { value: v }

pub macro '??'(l, r)
  let item = identifier("__item")
  \`
    let $item = $l
    if $item is Some:
      $item.value
    else:
      $r

pub fn main() -> i32
  some(5) ?? 0
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    expect(result.wasm).toBeInstanceOf(Uint8Array);

    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(5);
  });

  it("keeps fresh generated bindings distinct from each other and caller syntax", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
macro add_generated_values(value)
  let first = identifier("value")
  let second = identifier("value")
  \`
    let $first = 20
    let $second = 21
    $first + $second + $value

pub fn main() -> i32
  let value = 1
  add_generated_values(value)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("binds typed fresh locals by their identifier identity", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
macro generated_typed_value(name)
  let local = identifier("typed_local")
  \`(fn $name() -> i32
    let $local: i32 = 42
    $local)

generated_typed_value(generated_value)

pub fn main() -> i32
  generated_value()
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("binds fresh generic lambda type parameters", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
macro generated_identity()
  let generic = identifier("T")
  let value = identifier("value")
  \`(fn<$generic>($value: $generic) -> $generic => $value)

pub fn main() -> i32
  let identity: fn(i32) -> i32 = generated_identity()
  identity(42)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
        codegenOptions: { effectsHostBoundary: "off" },
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("binds fresh effects, operations, and handler parameters", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
macro declare_generated_effect(run)
  let effect = identifier("GeneratedFx")
  let operation = identifier("read")
  let handler_resume = identifier("resume")
  let handled_value = identifier("value")
  emit_many(
    \`(eff $effect
      fn $operation(resume, value: i32) -> i32),
    \`(fn $run(): $effect -> i32
      try
        $effect::$operation(5)
      $effect::$operation($handler_resume, $handled_value):
        $handler_resume($handled_value + 37))
  )

declare_generated_effect(run_generated)

pub fn main() -> i32
  run_generated()
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("omits fresh identifier debug labels from Wasm function names", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const emitNames = async (
      debugLabel: string,
    ): Promise<{ wat: string[]; runtimeDiagnostics: string[] }> => {
      const host = createMemoryHost({
        [mainPath]: `
macro declare_private_helper()
  let helper = identifier("${debugLabel}")
  emit_many(
    \`(fn $helper() -> i32 42),
    \`(pub fn main() -> i32 $helper())
  )

declare_private_helper()
`,
      });

      const result = expectCompileSuccess(
        await compileProgram({
          entryPath: mainPath,
          roots: { src: root },
          host,
        }),
      );
      const emitted = await emitProgram({
        graph: result.graph,
        semantics: result.semantics!,
        codegenOptions: { runtimeDiagnostics: true },
      });
      try {
        const wat = emitted.module.emitText();
        expect(wat).not.toContain(debugLabel);
        const rawBinary = emitted.module.emitBinary();
        const binary =
          rawBinary instanceof Uint8Array
            ? rawBinary
            : ((rawBinary as { binary?: Uint8Array; output?: Uint8Array })
                .output ??
              (rawBinary as { binary?: Uint8Array }).binary ??
              new Uint8Array());
        expect(new TextDecoder().decode(binary)).not.toContain(debugLabel);

        const wasm = new WebAssembly.Module(wasmBufferSource(binary));
        const sections = WebAssembly.Module.customSections(
          wasm,
          RUNTIME_DIAGNOSTICS_SECTION,
        );
        expect(sections).toHaveLength(1);
        const diagnostics = JSON.parse(
          new TextDecoder().decode(new Uint8Array(sections[0]!)),
        ) as {
          functions: Array<{ functionName: string }>;
        };
        const runtimeDiagnostics = diagnostics.functions.map(
          ({ functionName }) => functionName,
        );
        expect(runtimeDiagnostics).not.toContain(debugLabel);
        expect(
          runtimeDiagnostics.some((name) => /^hygienic_\d+$/.test(name)),
        ).toBe(true);
        return {
          wat: Array.from(
            wat.matchAll(/\(func \$([^\s(]*__hygienic_[^\s(]*)/g),
            (match) => match[1]!,
          ),
          runtimeDiagnostics,
        };
      } finally {
        emitted.module.dispose();
      }
    };

    const originalNames = await emitNames("diagnostic_only_helper");
    const renamedNames = await emitNames("renamed_debug_label");
    expect(originalNames.wat.length).toBeGreaterThan(0);
    expect(renamedNames).toEqual(originalNames);
  });

  it("omits fresh module-value and effect-operation labels from Wasm artifacts", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const labels = [
      "diagnostic_module_value",
      "DiagnosticEffect",
      "diagnostic_operation",
    ];
    const host = createMemoryHost({
      [mainPath]: `
macro declare_artifacts(run)
  let stored = identifier("${labels[0]}")
  let effect = identifier("${labels[1]}")
  let operation = identifier("${labels[2]}")
  emit_many(
    \`(let $stored = 40),
    \`(eff $effect
      fn $operation(resume, value: i32) -> i32),
    \`(fn $run(): $effect -> i32
      try
        $effect::$operation($stored)
      $effect::$operation(resume, value):
        resume(value + 2))
  )

declare_artifacts(generated)

pub fn main() -> i32
  generated()
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const semantics = result.semantics!;
    const modules = Array.from(semantics.values());
    const monomorphized = monomorphizeProgram({ modules, semantics });
    const emitted = codegenProgram({
      program: buildProgramCodegenView(modules, {
        instances: monomorphized.instances,
        moduleTyping: monomorphized.moduleTyping,
      }),
      entryModuleId: result.graph.entry,
    });
    try {
      const wat = emitted.module.emitText();
      const rawBinary = emitted.module.emitBinary();
      const binary =
        rawBinary instanceof Uint8Array
          ? rawBinary
          : ((rawBinary as { binary?: Uint8Array; output?: Uint8Array })
              .output ??
            (rawBinary as { binary?: Uint8Array }).binary ??
            new Uint8Array());
      const binaryText = new TextDecoder().decode(binary);
      const sidecarText = JSON.stringify(emitted.effectTable ?? {});
      labels.forEach((label) => {
        expect(wat).not.toContain(label);
        expect(binaryText).not.toContain(label);
        expect(sidecarText).not.toContain(label);
      });
      expect(wat).toContain("__module_let__");
      expect(wat).toContain("voydEffectArgs_0");
      expect(emitted.effectTable?.ops[0]?.label).toMatch(
        /::effect_\d+\.operation_\d+$/,
      );
    } finally {
      emitted.module.dispose();
    }
  });

  it("maps repeated fresh variant spellings through distinct enum namespaces", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const macrosPath = `${root}${sep}macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `#!no_prelude
use src::macros::all

declare_enum(First, Ready, Done)
declare_enum(Second, Ready, Done)

pub fn main() -> i32
  let first: First = First::Ready {}
  let second: Second = Second::Done {}
  match(first)
    First::Ready:
      match(second)
        Second::Ready:
          0
        Second::Done:
          3
    First::Done:
      0
`,
      [macrosPath]: `#!no_prelude
pub macro declare_enum(name, first, second)
  let first_internal = identifier(first)
  let second_internal = identifier(second)
  emit_many(
    \`(obj $first_internal {}),
    \`(obj $second_internal {}),
    \`(type ($name = ($first_internal | $second_internal)))
  )
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(3);
  });

  it("binds exported macro references to private definition-site symbols", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const macrosPath = `${root}${sep}macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::macros::all

fn private_helper(value: i32) -> i32
  0

obj PrivatePayload {}

eff PrivateFx
  noop(tail) -> i32

fn accepts_private_payload(value: private_payload_type()) -> i32
  1

fn declares_private_effect(): private_effect_type() -> i32
  1

pub fn main() -> i32
  private_helper(2) + call_private_helper(2) + call_literal_private_helper(2)
`,
      [macrosPath]: `
fn private_helper(value: i32) -> i32
  value + 38

obj PrivatePayload {}

eff PrivateFx
  noop(tail) -> i32

pub macro call_private_helper(value)
  let helper = symbol_reference(private_helper)
  \`($helper $value)

pub macro call_literal_private_helper(value)
  \`(private_helper $value)

pub macro private_payload_type()
  symbol_reference(PrivatePayload)

pub macro private_effect_type()
  symbol_reference(PrivateFx)
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(80);
  });

  it("resolves qualified symbol_reference operands in definition context", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const macrosPath = `${root}${sep}macros.voyd`;
    const toolsPath = `${root}${sep}tools.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::macros::all

pub fn main() -> i32
  let tool_lib = 0
  call_qualified_helper(2)
`,
      [macrosPath]: `
use src::tools::self as tool_lib

pub macro call_qualified_helper(value)
  let helper = symbol_reference(tool_lib::helper)
  \`($helper $value)
`,
      [toolsPath]: `
pub fn helper(value: i32) -> i32
  value + 40
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("keeps fresh generated declarations out of cross-module exports", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const producerPath = `${root}${sep}producer.voyd`;
    const macrosPath = `${root}${sep}macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::producer::debug_helper

pub fn main() -> i32
  debug_helper()
`,
      [producerPath]: `
use src::macros::all

declare_private()
`,
      [macrosPath]: `
pub macro declare_private()
  let name = identifier("debug_helper")
  \`(pub fn $name() -> i32 42)
`,
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("debug_helper"),
      ),
    ).toBe(true);
  });

  it.each([
    {
      kind: "module value",
      exportedName: "debug_value",
      producer: `
macro declare_private_value()
  let name = identifier("debug_value")
  \`(pub let $name = 42)

declare_private_value()
`,
      use: "debug_value",
    },
    {
      kind: "attribute-generated function",
      exportedName: "attribute_helper",
      producer: `
attribute macro replace(args, declaration)
  let name = identifier("attribute_helper")
  \`(pub fn $name() -> i32 42)

@replace
fn placeholder() -> i32
  0
`,
      use: "attribute_helper()",
    },
    {
      kind: "effect with an implicitly visible fresh operation",
      exportedName: "PublicFx",
      producer: `
macro declare_effect()
  let operation = identifier("hidden_operation")
  \`(pub eff PublicFx
    fn $operation(tail) -> i32)

declare_effect()
`,
      use: "0",
    },
    {
      kind: "trait with an implicitly visible fresh method",
      exportedName: "PublicTrait",
      producer: `
macro declare_trait()
  let method = identifier("hidden_method")
  \`(pub trait PublicTrait
    fn $method(self) -> i32)

declare_trait()
`,
      use: "0",
    },
  ])("keeps fresh $kind declarations out of exports", async (scenario) => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const producerPath = `${root}${sep}producer.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::producer::${scenario.exportedName}

pub fn main() -> i32
  ${scenario.use}
`,
      [producerPath]: scenario.producer,
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes(scenario.exportedName),
      ),
    ).toBe(true);
  });

  it("imports a private constructor through a type symbol_reference", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const macrosPath = `${root}${sep}macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::macros::all

obj PrivatePayload {}

pub fn main() -> i32
  make_private_payload(42).value
`,
      [macrosPath]: `
obj PrivatePayload {
  value: i32
}

impl PrivatePayload
  fn init(value: i32) -> PrivatePayload
    PrivatePayload { value }

pub macro make_private_payload(value)
  let payload = symbol_reference(PrivatePayload)
  \`($payload($value))
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("binds generated private impl targets by fresh identity", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
macro declare_box(factory)
  let box = identifier("PrivateBox")
  emit_many(
    \`(obj $box {}),
    \`(impl $box
      fn answer() -> i32
        42),
    \`(fn $factory() -> i32
      $box::answer())
  )

declare_box(read_generated)

pub fn main() -> i32
  read_generated()
`,
    });

    const result = expectCompileSuccess(
      await compileProgram({
        entryPath: mainPath,
        roots: { src: root },
        host,
      }),
    );
    const instance = getWasmInstance(result.wasm!);
    expect((instance.exports.main as () => number)()).toBe(42);
  });

  it("rejects unresolved symbol_reference targets", async () => {
    const root = resolve("/proj/src");
    const mainPath = `${root}${sep}main.voyd`;
    const macrosPath = `${root}${sep}macros.voyd`;
    const host = createMemoryHost({
      [mainPath]: `
use src::macros::all

pub fn main() -> i32
  missing_reference()
`,
      [macrosPath]: `
pub macro missing_reference()
  symbol_reference(not_declared)
`,
    });

    const result = await compileProgram({
      entryPath: mainPath,
      roots: { src: root },
      host,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const diagnostic = result.diagnostics.find(
      (entry) => entry.code === "BD0008",
    );
    expect(diagnostic).toMatchObject({
      message: expect.stringContaining("not_declared"),
      span: { file: mainPath },
    });
    expect(diagnostic?.related).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "note",
          span: expect.objectContaining({ file: macrosPath }),
        }),
      ]),
    );
  });
});
