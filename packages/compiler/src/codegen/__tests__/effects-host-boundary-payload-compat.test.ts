import { resolve } from "node:path";
import {
  defineVoydPackageAdapter,
  type VoydExternalFunctionContract,
} from "@voyd-lang/package-adapter";
import { parseExternalRequirements } from "@voyd-lang/js-host";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  parseEffectTable,
  runEffectfulExport,
} from "./support/effects-harness.js";

const fixturePath = (name: string) =>
  resolve(import.meta.dirname, "__fixtures__", name);

const dtoShimFixturePath = fixturePath("effects-export-dto-shim.voyd");
const unsupportedReturnFixturePath = fixturePath(
  "effects-export-object-return-unsupported.voyd",
);
const sameNameFixturePath = fixturePath("effects-op-wrapper-same-name.voyd");
const handledOnlyFixturePath = fixturePath(
  "effects-handled-before-host-boundary.voyd",
);
const externalFacadeFixturePath = fixturePath(
  "effects-external-facade/pkg.voyd",
);
const externalEffectId = "example:storage/document@1";

const toWebAssemblyModule = (bytes: Uint8Array): WebAssembly.Module => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new WebAssembly.Module(copy.buffer);
};

describe("host boundary payload compatibility", () => {
  it("supports API-to-DTO shim wrappers for effect payloads", async () => {
    const { module } = await compileEffectFixture({
      entryPath: dtoShimFixturePath,
    });
    const parsed = parseEffectTable(module);
    const op = parsed.ops.find((entry) =>
      entry.label.endsWith("HostBridge.take_box"),
    );
    if (!op) {
      throw new Error("missing HostBridge.take_box op entry");
    }

    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${op.opIndex}`]: (_request, raw: unknown) => (raw as number) + 1,
      },
    });

    expect(result.value).toBe(42);
  });

  it("reports unsupported effect return payloads at compile time", async () => {
    const result = await compileEffectFixture({
      entryPath: unsupportedReturnFixturePath,
      throwOnError: false,
    });
    const diagnostic = result.diagnostics.find(
      (diag) =>
        diag.code === "CG0001" &&
        diag.message.includes("HostOnly.roundtrip return value") &&
        diag.message.includes("unsupported type Box"),
    );
    expect(diagnostic).toBeDefined();
  });

  it("resolves same-name wrapper calls to functions instead of effect ops", async () => {
    const { module } = await compileEffectFixture({
      entryPath: sameNameFixturePath,
    });
    const parsed = parseEffectTable(module);
    const op = parsed.ops.find((entry) => entry.label.endsWith("Env.get"));
    if (!op) {
      throw new Error("missing Env.get op entry");
    }

    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers: {
        [`${op.opIndex}`]: (_request, key: unknown) => (key as number) + 1,
      },
    });

    expect(result.value).toBe(42);
  });

  it("does not require host DTO compatibility for effects handled before export", async () => {
    const result = await compileEffectFixture({
      entryPath: handledOnlyFixturePath,
      throwOnError: false,
    });
    const payloadDiagnostic = result.diagnostics.find(
      (diag) =>
        diag.code === "CG0001" &&
        diag.message.includes("Hidden.poke arg1") &&
        diag.message.includes("unsupported type Box"),
    );
    expect(payloadDiagnostic).toBeUndefined();

    const missingIdDiagnostic = result.diagnostics.find(
      (diag) =>
        diag.code === "CG0004" && diag.message.includes("public effect Hidden"),
    );
    expect(missingIdDiagnostic).toBeUndefined();
  });

  it("preserves external DTO contracts through facades", async () => {
    const { module } = await compileEffectFixture({
      entryPath: externalFacadeFixturePath,
    });
    const externalOps = parseEffectTable(module).ops.filter(
      (entry) => entry.effectId === externalEffectId,
    );
    expect(externalOps.map((entry) => entry.label)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Document\.roundtrip$/),
        expect.stringMatching(/Document\.inspect$/),
      ]),
    );

    const requirements = parseExternalRequirements(
      toWebAssemblyModule(module.emitBinary()),
    );
    expect(requirements.functions).toHaveLength(1);
    expect(requirements.functions).toMatchObject([
      {
        kind: "async",
        interfaceId: externalEffectId,
        functionName: "roundtrip",
      },
    ]);
    const contract = requirements.functions[0] as VoydExternalFunctionContract;

    const adapter = defineVoydPackageAdapter(
      {
        abiVersion: 1,
        packageName: "external-facade-test",
        functions: [contract],
      },
      {
        [externalEffectId]: {
          roundtrip: async (payload: unknown) => {
            expect(payload).toEqual({
              current: { tag: "Some", value: 1 },
              namespace: "facade",
              values: [20, 21],
            });
            return { tag: "Ok", value: 2 };
          },
        },
      },
    );
    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "through_facade_effectful",
      adapters: [adapter],
    });
    expect(result.value).toBe(43);
  });
});
