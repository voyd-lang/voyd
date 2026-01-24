import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { createVoydHost, parseExportAbi } from "@voyd/js-host";
import { compileProgram } from "../../pipeline.js";
import { createFsModuleHost } from "../../modules/fs-host.js";

const fixtureRoot = resolve(import.meta.dirname, "__fixtures__");
const stdRoot = resolve(import.meta.dirname, "../../../../std/src");

const buildModule = async (): Promise<Uint8Array> => {
  const entryPath = resolve(fixtureRoot, "msgpack-export.voyd");
  const result = await compileProgram({
    entryPath,
    roots: { src: fixtureRoot, std: stdRoot },
    host: createFsModuleHost(),
  });
  if (result.diagnostics.length > 0) {
    throw new Error(JSON.stringify(result.diagnostics, null, 2));
  }
  if (!result.wasm) {
    throw new Error("missing wasm output");
  }
  return result.wasm;
};

describe("export abi metadata", () => {
  it("marks msgpack signatures as serialized", async () => {
    const wasm = await buildModule();
    const module = new WebAssembly.Module(wasm);
    const abi = parseExportAbi(module);

    expect(abi.version).toBe(1);
    expect(abi.exports).toEqual([
      { name: "add", abi: "direct" },
      { name: "echo", abi: "serialized", formatId: "msgpack" },
    ]);
  });

  it("round-trips msgpack values for serialized exports", async () => {
    const wasm = await buildModule();
    const host = await createVoydHost({ wasm });
    const payload = [1, "hi", [true, 2]];
    const result = await host.runPure("echo", [payload]);
    expect(result).toEqual(payload);
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
          ])
        );
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, normalize(entry)])
        );
      }
      return value;
    };

    expect(normalize(result)).toEqual(payload);
  });
});
