import { describe, expect, it } from "vitest";
import { decodeBoundaryArgs } from "../boundary-values.js";
import { resolveHostTransport } from "../protocol/host-transport.js";

describe("boundary DTO decoding", () => {
  it("restores adapter-facing tags for unions and standalone variants", () => {
    const [union, variant] = decodeBoundaryArgs({
      exportName: "external variants",
      schemas: [
        {
          kind: "union",
          variants: [
            { name: "None", fields: [] },
            { name: "Some", fields: [{ name: "value", schema: { kind: "i32" } }] },
          ],
        },
        {
          kind: "record",
          tag: "Some",
          fields: [{ name: "value", schema: { kind: "i32" } }],
        },
      ],
      args: [{ $variant: "Some", value: 3 }, { value: 4 }],
    });

    expect(union).toEqual({ tag: "Some", value: 3 });
    expect(variant).toEqual({ tag: "Some", value: 4 });
  });
});

describe("host transport negotiation", () => {
  it("selects an adapter only by the exact emitted identity and ABI versions", () => {
    const adapter = {
      id: "example.transport",
      version: 3,
      encode: () => new Uint8Array([1]),
      decode: () => "decoded",
    };

    expect(
      resolveHostTransport({
        metadata: {
          hostAbi: 2,
          dtoSchemaAbi: 1,
          transport: { id: "example.transport", version: 3 },
        },
        adapters: [adapter],
      }),
    ).toBe(adapter);
  });

  it("rejects missing metadata, incompatible ABIs, and adapter version mismatches", () => {
    expect(() => resolveHostTransport({ metadata: undefined })).toThrow(
      "missing host transport metadata",
    );
    expect(() =>
      resolveHostTransport({
        metadata: {
          hostAbi: 1,
          dtoSchemaAbi: 1,
          transport: { id: "voyd.std.msgpack", version: 1 },
        },
      }),
    ).toThrow("Unsupported Voyd host ABI 1");
    expect(() =>
      resolveHostTransport({
        metadata: {
          hostAbi: 2,
          dtoSchemaAbi: 1,
          transport: { id: "voyd.std.msgpack", version: 2 },
        },
      }),
    ).toThrow("Missing Voyd host transport adapter voyd.std.msgpack@2");
  });
});
