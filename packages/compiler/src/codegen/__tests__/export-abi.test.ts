import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createVoydHost, parseExportAbi } from "@voyd/js-host";
import { compileProgram, type CompileProgramResult } from "../../pipeline.js";
import { createFsModuleHost } from "../../modules/fs-host.js";
import { wasmBufferSource } from "./support/wasm-utils.js";

const fixtureRoot = resolve(import.meta.dirname, "__fixtures__");
const stdRoot = resolve(import.meta.dirname, "../../../../std/src");

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
}: { entryFile?: string } = {}): Promise<Uint8Array> => {
  const entryPath = resolve(fixtureRoot, entryFile);
  const result = expectCompileSuccess(await compileProgram({
    entryPath,
    roots: { src: fixtureRoot, std: stdRoot },
    host: createFsModuleHost(),
  }));
  if (!result.wasm) {
    throw new Error("missing wasm output");
  }
  return result.wasm;
};

describe("export abi metadata", () => {
  it("marks msgpack signatures as serialized", async () => {
    const wasm = await buildModule();
    const module = new WebAssembly.Module(wasmBufferSource(wasm));
    const abi = parseExportAbi(module);

    expect(abi.version).toBe(1);
    expect(abi.exports).toEqual([
      { name: "add", abi: "direct" },
      { name: "echo", abi: "serialized", formatId: "msgpack" },
      { name: "fetch", abi: "serialized", formatId: "msgpack" },
    ]);
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
    const result = await host.runPure("fetch", []);
    expect(result).toEqual(["a", "b", "c"]);
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
});
