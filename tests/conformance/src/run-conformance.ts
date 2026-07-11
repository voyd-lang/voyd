import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { ConformanceCompileResult } from "./compiler-adapter.js";
import { loadCompilerAdapter } from "./load-compiler-adapter.js";
import {
  loadConformanceManifest,
  resolveConformanceEntry,
  type ConformanceCase,
} from "./manifest.js";

export const registerConformanceTests = (prefix: string): void => {
  const suites = loadConformanceManifest().suites.filter((suite) =>
    suite.id.startsWith(`${prefix}.`),
  );
  const adapter = loadCompilerAdapter();

  describe.each(suites)("$id", (suite) => {
    let compileResult: ConformanceCompileResult;

    beforeAll(async () => {
      compileResult = await (
        await adapter
      ).compile({
        entryPath: resolveConformanceEntry(suite.entry),
        optimize: suite.optimize,
      });
    });

    it.each(suite.cases)("$id: $title", async (testCase) => {
      await assertConformanceCase(compileResult, testCase);
    });
  });
};

const assertConformanceCase = async (
  result: ConformanceCompileResult,
  testCase: ConformanceCase,
): Promise<void> => {
  const expectation = testCase.expect;
  if (expectation.kind === "diagnostics") {
    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error(`Expected ${testCase.id} to fail compilation`);
    }

    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expectation.codes.forEach((code) => expect(codes).toContain(code));
    const messages = result.diagnostics
      .map((diagnostic) => diagnostic.message)
      .join("\n");
    expectation.messageIncludes?.forEach((text) =>
      expect(messages).toContain(text),
    );
    expectation.spans?.forEach(({ code, text }) => {
      const diagnostic = result.diagnostics.find(
        (candidate) => candidate.code === code && candidate.span,
      );
      expect(diagnostic?.span).toBeDefined();
      if (!diagnostic?.span) return;
      const source = readFileSync(diagnostic.span.file, "utf8");
      expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toBe(
        text,
      );
    });
    return;
  }

  if (!result.success) {
    throw new Error(
      result.diagnostics
        .map((diagnostic) => `${diagnostic.code} ${diagnostic.message}`)
        .join("\n"),
    );
  }
  expect(result.success).toBe(true);
  if (expectation.kind === "compile-success") {
    return;
  }
  if (expectation.kind === "wasm") {
    assertWasmExpectation(result.wasm, expectation);
    return;
  }
  if (!testCase.entryName) {
    throw new Error(
      `Runtime conformance case is missing entryName: ${testCase.id}`,
    );
  }

  const run = await result.program.run({
    entryName: testCase.entryName,
    host: testCase.host,
  });
  if (expectation.kind === "trap") {
    expect(run.success).toBe(false);
    if (run.success) {
      throw new Error(`Expected ${testCase.id} to trap`);
    }
    expectation.messageIncludes?.forEach((text) =>
      expect(run.trap.message).toContain(text),
    );
    expect(run.interactions).toEqual(testCase.interactions ?? []);
    return;
  }
  if (!run.success) {
    throw new Error(`${run.trap.name}: ${run.trap.message}`);
  }
  expect(run.success).toBe(true);
  expect(run.interactions).toEqual(testCase.interactions ?? []);
  if (expectation.kind === "equals") {
    expect(run.value).toEqual(expectation.value);
    return;
  }

  expect(run.value).toEqual(expect.any(Number));
  expect(run.value).toBeGreaterThanOrEqual(expectation.minInclusive);
  expect(run.value).toBeLessThan(expectation.maxExclusive);
};

const assertWasmExpectation = (
  wasm: Uint8Array,
  expectation: Extract<ConformanceCase["expect"], { kind: "wasm" }>,
): void => {
  const module = new WebAssembly.Module(wasm as BufferSource);
  const exports = WebAssembly.Module.exports(module).map(({ name }) => name);
  const imports = WebAssembly.Module.imports(module).map(
    ({ module: namespace, name }) => `${namespace}::${name}`,
  );

  expectation.exports?.forEach((name) => expect(exports).toContain(name));
  expectation.imports?.forEach((name) => expect(imports).toContain(name));
  expectation.absentImports?.forEach((name) =>
    expect(imports).not.toContain(name),
  );
};
