import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  createVoydHost,
  parseExportAbi,
} from "@voyd-lang/js-host";
import { compileProgram, type CompileProgramResult } from "../../pipeline.js";
import { createFsModuleHost } from "../../modules/fs-host.js";
import { wasmBufferSource } from "./support/wasm-utils.js";
import type { CodegenOptions } from "../context.js";

const fixtureRoot = resolve(import.meta.dirname, "__fixtures__");
const stdRoot = resolve(import.meta.dirname, "../../../../std/src");
const buildModuleCache = new Map<string, Promise<Uint8Array>>();

const withoutExportIds = (
  entries: ReturnType<typeof parseExportAbi>["exports"],
) => entries.map(({ id: _id, ...entry }) => entry);

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
  entryFile = "boundary-export.voyd",
  codegenOptions,
}: {
  entryFile?: string;
  codegenOptions?: CodegenOptions;
} = {}): Promise<Uint8Array> => {
  const cacheKey = JSON.stringify({
    entryFile,
    codegenOptions: codegenOptions ?? {},
  });
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
  it("derives automatic DTO exports for opaque VX values", async () => {
    const wasm = await buildModule({
      entryFile: "boundary-export-contract.voyd",
      codegenOptions: { boundaryExports: "auto" },
    });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);

    expect(abi.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "app",
          abi: "serialized",
        }),
        expect.objectContaining({ name: "add", abi: "direct" }),
      ]),
    );
  });

  it("unwraps compiler-derived canvas payloads through boundary metadata", async () => {
    const wasm = await buildModule({
      entryFile: "boundary-export-contract.voyd",
      codegenOptions: { boundaryExports: "auto" },
    });
    const host = await createVoydHost({ wasm });

    await expect(host.runPure("derived_canvas_frame", [])).resolves.toEqual({
      version: 2,
      selector: "#scene",
      width: 320,
      height: 180,
      clear: true,
      draws: [
        {
          kind: "line",
          from: { x: 1, y: 2 },
          to: { x: 3, y: 4 },
          color: "#ffffff",
          width: 1,
          alpha: 1,
          glowBlur: 0,
        },
      ],
    });

    const externalDraw = {
      kind: "line",
      from: { x: 10, y: 20 },
      to: { x: 30, y: 40 },
      color: "#77ddff",
      width: 2,
      alpha: 0.5,
      glowBlur: 0,
    };
    await expect(
      host.runPure("repack_canvas_frame", [externalDraw]),
    ).resolves.toEqual({
      version: 2,
      selector: "#repacked",
      width: 640,
      height: 360,
      clear: true,
      draws: [externalDraw],
    });
  });

  it("does not activate typed boundary exports from unrelated boundary helpers", async () => {
    const wasm = await buildModule({
      entryFile: "boundary-preview-export-contract.voyd",
    });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);

    expect(abi.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "view",
          abi: "direct",
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
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    ).toContain("boundary DTO incompatibility");
  });

  it("locates unsupported and ambiguous DTO shapes", async () => {
    const cases = [
      {
        fixture: "boundary-derived-codec-unsupported.voyd",
        path: "data::encode value",
        expected: "fn() -> i32 is not a supported DTO shape",
      },
      {
        fixture: "boundary-derived-codec-ambiguous.voyd",
        path: "data::encode value",
        expected:
          'variant payload fields named "tag" conflict with the JS boundary discriminator',
      },
      {
        fixture: "boundary-derived-codec-duplicate-variant.voyd",
        path: "data::encode value.RepeatedBoundaryVariant",
        expected:
          'multiple union variants use the "$variant" discriminator "RepeatedBoundaryVariant"',
      },
    ];

    for (const testCase of cases) {
      const result = await compileProgram({
        entryPath: resolve(fixtureRoot, testCase.fixture),
        roots: { src: fixtureRoot, std: stdRoot },
        host: createFsModuleHost(),
        codegenOptions: { validate: true },
      });

      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error(`expected ${testCase.fixture} to fail`);
      }
      expect(
        result.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "CG0001" &&
            diagnostic.span.start > 0 &&
            diagnostic.message.includes(testCase.path) &&
            diagnostic.message.includes(testCase.expected),
        ),
      ).toBe(true);
    }
  });

  it("exports memory for serialized wrappers under linearMemoryExport: auto", async () => {
    const wasm = await buildModule({
      codegenOptions: {
        boundaryExports: "auto",
        linearMemoryExport: "auto",
      },
    });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const exports = WebAssembly.Module.exports(module).map(
      (entry) => entry.name,
    );
    expect(exports).toContain("memory");
  });

  it("emits schema metadata and distinct wrappers for automatic boundary exports", async () => {
    const wasm = await buildModule({
      entryFile: "boundary-export.voyd",
      codegenOptions: { boundaryExports: "auto" },
    });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);
    const exports = WebAssembly.Module.exports(module).map(
      (entry) => entry.name,
    );

    expect(exports).toContain("translate");
    expect(exports).toContain("__voyd_serialized_export_translate");
    expect(exports).not.toContain("__voyd_serialized_export_primitive");
    expect(exports).not.toContain("__voyd_serialized_export_echo_bool");
    expect(exports).not.toContain("__voyd_serialized_export_echo_i64");
    expect(exports).not.toContain("__voyd_serialized_export_echo_f32");
    expect(abi.exports).not.toContainEqual(
      expect.objectContaining({ name: "call_callback", abi: "serialized" }),
    );
    expect(withoutExportIds(abi.exports)).toEqual([
      {
        name: "echo_bool",
        abi: "direct",
        params: [expect.objectContaining({ kind: "bool" })],
        result: expect.objectContaining({ kind: "bool" }),
      },
      expect.objectContaining({
        name: "echo_bytes",
        abi: "serialized",
        params: [
          expect.objectContaining({
            kind: "bytes",
            fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        ],
        result: expect.objectContaining({
          kind: "bytes",
          fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
      }),
      {
        name: "echo_f32",
        abi: "direct",
        params: [expect.objectContaining({ kind: "f32" })],
        result: expect.objectContaining({ kind: "f32" }),
      },
      {
        name: "echo_i64",
        abi: "direct",
        params: [expect.objectContaining({ kind: "i64" })],
        result: expect.objectContaining({ kind: "i64" }),
      },
      expect.objectContaining({
        name: "echo_user_id",
        abi: "serialized",
        params: [
          expect.objectContaining({
            kind: "custom",
            representation: expect.objectContaining({ kind: "record" }),
          }),
        ],
        result: expect.objectContaining({
          kind: "custom",
          representation: expect.objectContaining({ kind: "record" }),
        }),
      }),
      expect.objectContaining({
        name: "echo_user_profile",
        abi: "serialized",
        params: [expect.objectContaining({ kind: "record" })],
        result: expect.objectContaining({ kind: "record" }),
      }),
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
      {
        name: "primitive",
        abi: "direct",
        params: [],
        result: expect.objectContaining({ kind: "i32" }),
      },
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

    const translate = abi.exports.find((entry) => entry.name === "translate");
    expect(translate?.params?.[0]?.fingerprint).toBe(
      translate?.result?.fingerprint,
    );
  });

  it("round-trips Bytes as a distinct automatic DTO primitive", async () => {
    const wasm = await buildModule({
      entryFile: "boundary-export.voyd",
      codegenOptions: { boundaryExports: "auto" },
    });
    const host = await createVoydHost({ wasm });
    const source = new Uint8Array([0, 1, 127, 255]);

    const result = await host.runPure<Uint8Array>("echo_bytes", [source]);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual(Array.from(source));
  });

  it("round-trips a custom DTO through its single representation", async () => {
    const wasm = await buildModule({
      entryFile: "boundary-export.voyd",
      codegenOptions: { boundaryExports: "auto" },
    });
    const host = await createVoydHost({ wasm });

    await expect(host.runPure("echo_user_id", [{ id: 7 }])).resolves.toEqual({
      id: 7,
    });
    await expect(
      host.runPure("echo_user_profile", [{ user: { id: 0 } }]),
    ).rejects.toMatchObject({
      failure: {
        direction: "host->vm",
        frameCategory: "export-invocation",
        phase: "decode",
        category: "custom",
        code: "user_id.non_positive",
        providerCode: "voyd.std.msgpack",
        message: "user id must be positive",
        path: ["$.user"],
      },
    });
  });

  it("rejects integers outside the byte domain before transport encoding", async () => {
    const wasm = await buildModule({
      entryFile: "dto-boundary-errors.voyd",
      codegenOptions: { boundaryExports: "auto" },
    });
    const host = await createVoydHost({ wasm });

    await expect(host.runPure("reject_invalid_byte")).rejects.toThrow();
  });

  it("rejects cyclic data encoding instead of returning sentinel data", async () => {
    const wasm = await buildModule({
      entryFile: "dto-boundary-errors.voyd",
      codegenOptions: { boundaryExports: "auto" },
    });
    const host = await createVoydHost({ wasm });

    await expect(host.runPure("reject_cyclic_data")).rejects.toThrow();
  });

  it("keeps typed boundary export helpers reachable under optimization", async () => {
    const wasm = await buildModule({
      entryFile: "boundary-export.voyd",
      codegenOptions: { boundaryExports: "auto", optimize: true },
    });
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);
    const exports = WebAssembly.Module.exports(module).map(
      (entry) => entry.name,
    );

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
      const exports = WebAssembly.Module.exports(module).map(
        (entry) => entry.name,
      );

      expect(exports).toContain("translate");
      expect(exports).not.toContain("__voyd_serialized_export_translate");
      expect(abi.exports).toContainEqual(
        expect.objectContaining({ name: "translate", abi: "direct" }),
      );
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
      entryPath: resolve(fixtureRoot, "boundary-export-contract.voyd"),
      roots: { src: fixtureRoot, std: stdRoot },
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
    const exports = WebAssembly.Module.exports(module).map(
      (entry) => entry.name,
    );
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
