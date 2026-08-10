import { describe, expect, it } from "vitest";
import { decodeBoundaryArgs } from "../boundary-values.js";
import { resolveHostTransport } from "../protocol/host-transport.js";
import type { HostFrame } from "../protocol/host-frame.js";
import { msgPackHostTransport } from "../transports/msgpack.js";

describe("boundary DTO decoding", () => {
  it("restores adapter-facing tags for unions and standalone variants", () => {
    const [union, variant] = decodeBoundaryArgs({
      exportName: "external variants",
      schemas: [
        {
          kind: "union",
          variants: [
            { name: "None", fields: [] },
            {
              name: "Some",
              fields: [{ name: "value", schema: { kind: "i32" } }],
            },
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
      encodeFrame: () => new Uint8Array([2]),
      decodeFrame: () => ({
        kind: "cancellation-acknowledgement" as const,
        operationId: 1,
        accepted: true,
      }),
      encode: () => new Uint8Array([1]),
      decode: () => "decoded",
    };

    expect(
      resolveHostTransport({
        metadata: {
          hostAbi: 1,
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
          hostAbi: 2,
          dtoSchemaAbi: 1,
          transport: { id: "voyd.std.msgpack", version: 1 },
        },
      }),
    ).toThrow("Unsupported Voyd host ABI 2");
    expect(() =>
      resolveHostTransport({
        metadata: {
          hostAbi: 1,
          dtoSchemaAbi: 1,
          transport: { id: "voyd.std.msgpack", version: 2 },
        },
      }),
    ).toThrow("Missing Voyd host transport adapter voyd.std.msgpack@2");
  });
});

describe("host ABI v2 frames", () => {
  it("round-trips every complete frame category through MessagePack", () => {
    const value = { fingerprint: "sha256:abc", value: { count: 2 } };
    const outcome = { kind: "success" as const, value };
    const frames: readonly HostFrame[] = [
      { kind: "export-invocation", exportName: "main", args: [value] },
      { kind: "export-completion", exportName: "main", outcome },
      {
        kind: "effect-request",
        requestId: 1,
        effectId: "voyd.std.fs",
        operationId: 2,
        signatureHash: 3,
        resumeKind: 0,
        args: [value],
        resultFingerprint: "sha256:result",
      },
      { kind: "effect-outcome", requestId: 1, outcome },
      {
        kind: "callback-invocation",
        invocationId: 3,
        callbackId: 4,
        args: [value],
      },
      { kind: "callback-completion", invocationId: 3, outcome },
      { kind: "cancellation", operationId: 5, reason: "stopped" },
      {
        kind: "cancellation-acknowledgement",
        operationId: 5,
        accepted: true,
      },
      { kind: "vx-command", sessionId: 6, commandId: 7, command: value },
      { kind: "vx-event", sessionId: 6, event: value },
      {
        kind: "vx-extension-request",
        sessionId: 6,
        requestId: 8,
        extensionId: "example",
        request: value,
      },
      {
        kind: "vx-extension-outcome",
        sessionId: 6,
        requestId: 8,
        outcome,
      },
      {
        kind: "external-invocation",
        interfaceId: "example.interface",
        functionName: "read",
        args: [value],
      },
      {
        kind: "external-completion",
        interfaceId: "example.interface",
        functionName: "read",
        outcome: {
          kind: "failure",
          failure: {
            code: "example.failure",
            message: "failed",
            path: ["field", 1],
          },
        },
      },
    ];

    frames.forEach((frame) => {
      expect(
        msgPackHostTransport.decodeFrame(
          msgPackHostTransport.encodeFrame(frame),
        ),
      ).toEqual(frame);
    });
  });

  it("rejects a value that is not a complete frame", () => {
    expect(() =>
      msgPackHostTransport.decodeFrame(msgPackHostTransport.encode([2, 99])),
    ).toThrow("Unknown Voyd host frame tag 99");
  });
});
