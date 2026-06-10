import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createVoydHost, parseExportAbi } from "@voyd-lang/js-host";
import { compileProgram, type CompileProgramResult } from "../../pipeline.js";
import { createFsModuleHost } from "../../modules/fs-host.js";
import { wasmBufferSource } from "./support/wasm-utils.js";
import type { CodegenOptions } from "../context.js";

const fixtureRoot = resolve(import.meta.dirname, "__fixtures__");
const smokeFixtureRoot = resolve(
  import.meta.dirname,
  "../../../../../apps/smoke/fixtures",
);
const stdRoot = resolve(import.meta.dirname, "../../../../std/src");
const buildModuleCache = new Map<string, Promise<Uint8Array>>();

const expectCompileSuccess = (
  result: CompileProgramResult,
): Extract<CompileProgramResult, { success: true }> => {
  if (!result.success) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  expect(result.success).toBe(true);
  return result;
};

const buildModule = async ({
  entryFile = "msgpack-export.voyd",
  codegenOptions,
}: {
  entryFile?: string;
  codegenOptions?: CodegenOptions;
} = {}): Promise<Uint8Array> => {
  const cacheKey = JSON.stringify({ entryFile, codegenOptions: codegenOptions ?? {} });
  const cached = buildModuleCache.get(cacheKey);
  if (cached) return cached;

  const entryPath = resolve(fixtureRoot, entryFile);
  const wasm = compileProgram({
    entryPath,
    roots: { src: fixtureRoot, std: stdRoot },
    host: createFsModuleHost(),
    codegenOptions,
  }).then((result) => {
    const compiled = expectCompileSuccess(result);
    if (!compiled.wasm) {
      throw new Error("missing wasm output");
    }
    return compiled.wasm;
  });
  buildModuleCache.set(cacheKey, wasm);
  return wasm;
};

describe("export abi metadata", { timeout: 60_000 }, () => {
  it("marks msgpack signatures as serialized", async () => {
    const wasm = await buildModule();
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);

    expect(abi.version).toBe(1);
    expect(abi.exports).toEqual([
      { name: "add", abi: "direct" },
      { name: "echo", abi: "serialized", formatId: "msgpack" },
      { name: "fetch_items", abi: "serialized", formatId: "msgpack" },
    ]);
  });

  it("does not serialize unrelated DTO-compatible exports in boundary modules", async () => {
    const wasm = await buildModule({ entryFile: "boundary-export-contract.voyd" });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);

    expect(abi.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "app",
          abi: "serialized",
          formatId: "msgpack",
        }),
        expect.objectContaining({
          name: "echo_command",
          abi: "serialized",
          formatId: "msgpack",
        }),
        expect.objectContaining({ name: "add", abi: "direct" }),
      ]),
    );
  });

  it("decodes boundary payload envelopes in serialized params", async () => {
    const wasm = await buildModule({ entryFile: "boundary-export-contract.voyd" });
    const host = await createVoydHost({ wasm });
    const payload = {
      type: "cmd",
      kind: "message",
      value: { Increment: {} },
    };

    const result = await host.runPure("echo_command", [payload]);

    expect(result).toEqual(payload);
  });

  it("does not activate companion boundary exports from unrelated boundary helpers", async () => {
    const wasm = await buildModule({
      entryFile: "boundary-preview-export-contract.voyd",
    });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);

    expect(abi.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "view",
          abi: "serialized",
          formatId: "msgpack",
        }),
        expect.objectContaining({ name: "init", abi: "direct" }),
      ]),
    );
  });

  it("reports unsupported explicit boundary export DTOs", async () => {
    const result = await compileProgram({
      entryPath: resolve(fixtureRoot, "boundary-export-unsupported.voyd"),
      roots: { src: fixtureRoot, std: stdRoot },
      host: createFsModuleHost(),
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "boundary DTO incompatibility",
    );
  });

  it("round-trips msgpack values for serialized exports", async () => {
    const wasm = await buildModule();
    const host = await createVoydHost({ wasm });
    const payload = [1, "hi", [true, 2]];
    const result = await host.runPure("echo", [payload]);
    expect(result).toEqual(payload);
  });

  it("fetches msgpack values for serialized exports", async () => {
    const wasm = await buildModule();
    const host = await createVoydHost({ wasm });
    const result = await host.runPure("fetch_items", []);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("keeps serialized export helpers reachable under optimization without boundary exports", async () => {
    const wasm = await buildModule({
      codegenOptions: { optimize: true, boundaryExports: false },
    });
    const host = await createVoydHost({ wasm });
    const result = await host.runPure("fetch_items", []);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("exports memory for serialized wrappers under linearMemoryExport: auto", async () => {
    const wasm = await buildModule({
      codegenOptions: { linearMemoryExport: "auto" },
    });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);
    expect(exports).toContain("memory");
  });

  it("round-trips complex msgpack values", async () => {
    const wasm = await buildModule();
    const host = await createVoydHost({ wasm });
    const payload = {
      user: { name: "Ada", tags: ["math", "logic"] },
      counts: [1, 2, 3],
      ok: true,
      nested: [{ id: 1 }, { id: 2, flags: [true, false] }],
    };
    const result = await host.runPure("echo", [payload]);

    const normalize = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(normalize);
      }
      if (value instanceof Map) {
        return Object.fromEntries(
          Array.from(value.entries()).map(([key, entry]) => [
            String(key),
            normalize(entry),
          ]),
        );
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, normalize(entry)]),
        );
      }
      return value;
    };

    expect(normalize(result)).toEqual(payload);
  });

  it("marks imported recursive msgpack aliases as serialized", async () => {
    const wasm = await buildModule({ entryFile: "msgpack_import_main.voyd" });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);

    expect(abi.exports).toEqual([
      { name: "fetch", abi: "serialized", formatId: "msgpack" },
    ]);
  });

  it("emits schema metadata and distinct wrappers for automatic boundary exports", async () => {
    const wasm = await buildModule({
      entryFile: "boundary-export.voyd",
      codegenOptions: { boundaryExports: "auto" },
    });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);
    const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);

    expect(exports).toContain("translate");
    expect(exports).toContain("__voyd_serialized_export_translate");
    expect(abi.exports).not.toContainEqual(
      expect.objectContaining({ name: "call_callback", abi: "serialized" }),
    );
    expect(abi.exports).toEqual([
      expect.objectContaining({
        name: "get_point",
        abi: "serialized",
        wrapperName: "__voyd_serialized_export_get_point",
        params: [],
        result: expect.objectContaining({ kind: "record" }),
      }),
      expect.objectContaining({
        name: "lookup",
        abi: "serialized",
        wrapperName: "__voyd_serialized_export_lookup",
        params: [expect.objectContaining({ kind: "string" })],
        result: expect.objectContaining({ kind: "union" }),
      }),
      expect.objectContaining({
        name: "sum_values",
        abi: "serialized",
        wrapperName: "__voyd_serialized_export_sum_values",
        params: [expect.objectContaining({ kind: "array" })],
        result: expect.objectContaining({ kind: "i32" }),
      }),
      expect.objectContaining({
        name: "translate",
        abi: "serialized",
        wrapperName: "__voyd_serialized_export_translate",
        params: [
          expect.objectContaining({ kind: "record" }),
          expect.objectContaining({ kind: "i32" }),
          expect.objectContaining({ kind: "i32" }),
        ],
        result: expect.objectContaining({ kind: "record" }),
      }),
    ]);
  });

  it("keeps typed boundary export helpers reachable under optimization", async () => {
    const wasm = await buildModule({
      entryFile: "boundary-export.voyd",
      codegenOptions: { boundaryExports: "auto", optimize: true },
    });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);
    const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);

    expect(exports).toContain("__voyd_serialized_export_translate");
    expect(abi.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "translate",
          abi: "serialized",
          wrapperName: "__voyd_serialized_export_translate",
        }),
      ]),
    );
  });

  it.each([false, "off"] as const)(
    "leaves automatic boundary exports off when disabled with %s",
    async (boundaryExports) => {
      const wasm = await buildModule({
        entryFile: "boundary-export.voyd",
        codegenOptions: { boundaryExports },
      });
      const module = new WebAssembly.Module(wasmBufferSource(wasm));
      const abi = parseExportAbi(module);
      const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);

      expect(exports).toContain("translate");
      expect(exports).not.toContain("__voyd_serialized_export_translate");
      expect(abi.exports).toContainEqual({ name: "translate", abi: "direct" });
    },
  );

  it("reports diagnostics for unsupported explicitly requested boundary exports", async () => {
    const result = await compileProgram({
      entryPath: resolve(fixtureRoot, "boundary-export.voyd"),
      roots: { src: fixtureRoot, std: stdRoot },
      host: createFsModuleHost(),
      codegenOptions: {
        boundaryExports: { mode: "only", include: ["call_callback"] },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected explicit boundary export compile failure");
    }
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("typed boundary export call_callback"),
      ),
    ).toBe(true);
  });

  it("reports diagnostics for unsupported included exports in explicit auto mode", async () => {
    const result = await compileProgram({
      entryPath: resolve(fixtureRoot, "boundary-export.voyd"),
      roots: { src: fixtureRoot, std: stdRoot },
      host: createFsModuleHost(),
      codegenOptions: {
        boundaryExports: {
          mode: "auto",
          include: ["call_callback"],
        },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected included boundary export compile failure");
    }
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes(
          "typed boundary export call_callback was requested but was not emitted",
        ),
      ),
    ).toBe(true);
  });

  it("treats include-only boundary export options as explicit requests", async () => {
    const result = await compileProgram({
      entryPath: resolve(fixtureRoot, "boundary-export.voyd"),
      roots: { src: fixtureRoot, std: stdRoot },
      host: createFsModuleHost(),
      codegenOptions: {
        boundaryExports: { include: ["missing_export"] },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected include-only boundary export compile failure");
    }
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes(
          "typed boundary export missing_export was requested but was not emitted",
        ),
      ),
    ).toBe(true);
  });

  it("does not count private VX lifecycle callbacks as explicit boundary includes", async () => {
    const result = await compileProgram({
      entryPath: resolve(smokeFixtureRoot, "vx-typed-counter.voyd"),
      roots: { src: smokeFixtureRoot, std: stdRoot },
      host: createFsModuleHost(),
      codegenOptions: {
        boundaryExports: { include: ["view"] },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes(
          "typed boundary export view was requested but was not emitted",
        ),
      ),
    ).toBe(true);
  });

  it("avoids wrapper export name collisions with user exports", async () => {
    const wasm = await buildModule({
      entryFile: "boundary-export-collision.voyd",
      codegenOptions: { boundaryExports: "auto" },
    });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);
    const exports = WebAssembly.Module.exports(module).map((entry) => entry.name);
    const translate = abi.exports.find((entry) => entry.name === "translate");

    expect(exports).toContain("translate");
    expect(exports).toContain("__voyd_serialized_export_translate");
    expect(exports).toContain("__voyd_serialized_export_translate_1");
    expect(translate).toEqual(
      expect.objectContaining({
        abi: "serialized",
        wrapperName: "__voyd_serialized_export_translate_1",
      }),
    );
  });

  it("reports diagnostics for variant payload fields that collide with the JS tag discriminator", async () => {
    const result = await compileProgram({
      entryPath: resolve(fixtureRoot, "boundary-tag-collision.voyd"),
      roots: { src: fixtureRoot, std: stdRoot },
      host: createFsModuleHost(),
      codegenOptions: {
        boundaryExports: { include: ["tagged_result"] },
      },
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected tag collision boundary export compile failure");
    }
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes(
          'variant payload fields named "tag" conflict with the JS boundary discriminator',
        ),
      ),
    ).toBe(true);
  });
});
