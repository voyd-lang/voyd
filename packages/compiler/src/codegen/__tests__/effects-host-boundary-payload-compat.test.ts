import { resolve } from "node:path";
import { defineVoydPackageAdapter } from "@voyd-lang/package-adapter";
import { parseExternalRequirements } from "@voyd-lang/js-host";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  parseEffectTable,
  runEffectfulExport,
} from "./support/effects-harness.js";

const dtoShimFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-dto-shim.voyd",
);

const unsupportedReturnFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-object-return-unsupported.voyd",
);

const sameNameFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-op-wrapper-same-name.voyd",
);

const handledOnlyFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-handled-before-host-boundary.voyd",
);

const externalFacadeFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-external-facade",
  "app",
  "main.voyd",
);
const externalFacadePackageDir = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-external-facade",
  "packages",
);
const externalDirectFixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-external-facade",
  "app",
  "direct.voyd",
);

const toWebAssemblyModule = (bytes: Uint8Array): WebAssembly.Module => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new WebAssembly.Module(copy.buffer);
};

describe("host boundary payload compatibility", () => {
  it("supports API-to-DTO shim wrappers for effect payloads", async () => {
    const { module } = await compileEffectFixture({ entryPath: dtoShimFixturePath });
    const parsed = parseEffectTable(module);
    const op = parsed.ops.find((entry) => entry.label.endsWith("HostBridge.take_box"));
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
    const { module } = await compileEffectFixture({ entryPath: sameNameFixturePath });
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

  it("preserves external DTO contracts through imported facade functions", async () => {
    const { module } = await compileEffectFixture({
      entryPath: externalFacadeFixturePath,
      pkgDirs: [externalFacadePackageDir],
    });
    const parsed = parseEffectTable(module);
    const operations = parsed.ops.filter(
      (entry) => entry.effectId === "example:storage/document@1",
    );

    expect(operations).toHaveLength(1);
    expect(operations[0]?.label).toMatch(/Document\.roundtrip$/);

    const requirements = parseExternalRequirements(
      toWebAssemblyModule(module.emitBinary()),
    );
    expect(requirements.functions).toMatchObject([
      {
        kind: "async",
        interfaceId: "example:storage/document@1",
        functionName: "roundtrip",
        params: [
          { kind: "string" },
          {
            kind: "record",
            fields: [
              { name: "namespace", schema: { kind: "string" } },
              {
                name: "values",
                schema: { kind: "array", element: { kind: "i32" } },
              },
            ],
          },
          {
            kind: "union",
            variants: [
              { name: "None", fields: [] },
              {
                name: "Some",
                fields: [
                  {
                    name: "value",
                    schema: { kind: "record" },
                  },
                ],
              },
            ],
          },
        ],
        result: {
          kind: "union",
          variants: [
            { name: "Ok" },
            { name: "Err" },
          ],
        },
      },
    ]);

    const contract = {
      kind: "async" as const,
      interfaceId: "example:storage/document@1",
      functionName: "roundtrip",
      params: [
        { kind: "string" as const },
        {
          kind: "record" as const,
          fields: [
            { name: "namespace", schema: { kind: "string" as const } },
            {
              name: "values",
              schema: {
                kind: "array" as const,
                element: { kind: "i32" as const },
              },
            },
          ],
        },
        {
          kind: "union" as const,
          variants: [
            { name: "None", fields: [] },
            {
              name: "Some",
              fields: [
                {
                  name: "value",
                  schema: {
                    kind: "record" as const,
                    fields: [
                      {
                        name: "namespace",
                        schema: { kind: "string" as const },
                      },
                      {
                        name: "values",
                        schema: {
                          kind: "array" as const,
                          element: { kind: "i32" as const },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
      result: {
        kind: "union" as const,
        variants: [
          {
            name: "Ok",
            fields: [
              {
                name: "value",
                schema: {
                  kind: "array" as const,
                  element: {
                    kind: "record" as const,
                    fields: [
                      {
                        name: "namespace",
                        schema: { kind: "string" as const },
                      },
                      {
                        name: "values",
                        schema: {
                          kind: "array" as const,
                          element: { kind: "i32" as const },
                        },
                      },
                    ],
                  },
                },
              },
            ],
          },
          {
            name: "Err",
            fields: [
              {
                name: "error",
                schema: {
                  kind: "record" as const,
                  fields: [
                    { name: "message", schema: { kind: "string" as const } },
                  ],
                },
              },
            ],
          },
        ],
      },
    };
    const adapter = defineVoydPackageAdapter(
      {
        abiVersion: 1,
        packageName: "external-facade-test",
        functions: [contract],
      },
      {
        "example:storage/document@1": {
          roundtrip: async (
            namespace: unknown,
            record: unknown,
            current: unknown,
          ) => {
            expect(namespace).toMatch(/^(facade|non-generic|direct)$/);
            expect(record).toEqual({
              namespace,
              values: [20, 21],
            });
            if (namespace === "facade") {
              expect(current).toEqual({
                tag: "Some",
                value: record,
              });
            } else {
              expect(current).toEqual({ tag: "None" });
            }
            return { tag: "Ok", value: [record] };
          },
        },
      },
    );

    const facadeResult = await runEffectfulExport<number>({
      wasm: module,
      entryName: "through_facade_effectful",
      adapters: [adapter],
    });
    expect(facadeResult.value).toBe(41);

    const nonGenericFacadeResult = await runEffectfulExport<number>({
      wasm: module,
      entryName: "through_non_generic_facade_effectful",
      adapters: [adapter],
    });
    expect(nonGenericFacadeResult.value).toBe(1);

    const direct = await compileEffectFixture({
      entryPath: externalDirectFixturePath,
      pkgDirs: [externalFacadePackageDir],
    });
    const directOperations = parseEffectTable(direct.module).ops.filter(
      (entry) => entry.effectId === "example:storage/document@1",
    );
    expect(directOperations).toHaveLength(1);

    const directResult = await runEffectfulExport<number>({
      wasm: direct.module,
      entryName: "direct_effectful",
      adapters: [adapter],
    });
    expect(directResult.value).toBe(1);
  });
});
