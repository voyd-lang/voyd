import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import { wasmBufferSource } from "./support/wasm-utils.js";

const exportNames = (mod: WebAssembly.Module): string[] =>
  WebAssembly.Module.exports(mod)
    .map((entry) => entry.name)
    .sort();

const importNames = (mod: WebAssembly.Module): string[] =>
  WebAssembly.Module.imports(mod)
    .map((entry) => `${entry.module}::${entry.name}`)
    .sort();

const compileExports = ({
  source,
  options,
}: {
  source: string;
  options?: Parameters<typeof codegen>[1];
}): string[] => {
  const ast = parse(source, "memory_exports_test.voyd");
  const semantics = semanticsPipeline(ast);
  const { module } = codegen(semantics, {
    effectsHostBoundary: "off",
    ...(options ?? {}),
  });
  const wasmModule = new WebAssembly.Module(
    wasmBufferSource(module.emitBinary()),
  );
  return exportNames(wasmModule);
};

const compileImports = ({
  source,
  options,
}: {
  source: string;
  options?: Parameters<typeof codegen>[1];
}): string[] => {
  const ast = parse(source, "memory_imports_test.voyd");
  const semantics = semanticsPipeline(ast);
  const { module } = codegen(semantics, {
    effectsHostBoundary: "off",
    ...(options ?? {}),
  });
  const wasmModule = new WebAssembly.Module(
    wasmBufferSource(module.emitBinary()),
  );
  return importNames(wasmModule);
};

const compileInstance = ({
  source,
  options,
}: {
  source: string;
  options?: Parameters<typeof codegen>[1];
}): WebAssembly.Instance => {
  const ast = parse(source, "memory_exports_instance_test.voyd");
  const semantics = semanticsPipeline(ast);
  const { module } = codegen(semantics, {
    effectsHostBoundary: "off",
    ...(options ?? {}),
  });
  const wasmModule = new WebAssembly.Module(
    wasmBufferSource(module.emitBinary()),
  );
  return new WebAssembly.Instance(wasmModule, {});
};

describe("codegen memory exports", () => {
  const baseSource = `pub fn main() -> i32
  1`;

  it("exports linear memory by default", () => {
    const names = compileExports({ source: baseSource });
    expect(names).toContain("memory");
    expect(names).not.toContain("effects_memory");
  });

  it("respects linearMemoryExport: off", () => {
    const names = compileExports({
      source: baseSource,
      options: { linearMemoryExport: "off" },
    });
    expect(names).not.toContain("memory");
  });

  it("exports effects_memory when effectsMemoryExport is always", () => {
    const names = compileExports({
      source: baseSource,
      options: {
        linearMemoryExport: "off",
        effectsMemoryExport: "always",
      },
    });
    expect(names).toContain("memory");
    expect(names).toContain("effects_memory");
  });

  it("aliases effects_memory to linear memory", () => {
    const instance = compileInstance({
      source: baseSource,
      options: {
        linearMemoryExport: "always",
        effectsMemoryExport: "always",
      },
    });
    const linear = instance.exports["memory" as keyof WebAssembly.Exports];
    const effects =
      instance.exports["effects_memory" as keyof WebAssembly.Exports];
    expect(linear).toBeInstanceOf(WebAssembly.Memory);
    expect(effects).toBe(linear);
  });

  it("does not require voyd_math imports for non-math programs", () => {
    const imports = compileImports({ source: baseSource });
    expect(imports).not.toContain("voyd_math::sin");
    expect(imports).not.toContain("voyd_math::pow");
    expect(imports.some((name) => name.startsWith("voyd_math::"))).toBe(false);
  });
});
