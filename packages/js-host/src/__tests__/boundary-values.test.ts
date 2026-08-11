import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeBoundaryArgs,
  decodeBoundaryResult,
  encodeBoundaryArgs,
} from "../boundary-values.js";
import { resolveHostTransport } from "../protocol/host-transport.js";
import {
  HostFrameFailureError,
  type HostFrame,
} from "../protocol/host-frame.js";
import { decodeHostCompletion } from "../runtime/dispatch.js";
import { msgPackHostTransport } from "../transports/msgpack.js";
import { encode } from "@msgpack/msgpack";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const genericRuntimeFiles = (root: string): string[] =>
  readdirSync(root).flatMap((entry) => {
    if (root === SOURCE_ROOT && ["transports", "__tests__"].includes(entry)) {
      return [];
    }
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      return genericRuntimeFiles(path);
    }
    if (
      !path.endsWith(".ts") ||
      path.endsWith(".test.ts") ||
      path === resolve(SOURCE_ROOT, "index.ts")
    ) {
      return [];
    }
    return [path];
  });

describe("boundary DTO decoding", () => {
  it("preserves the complete failure record from completion frames", () => {
    const failure = {
      direction: "vm->host" as const,
      frameCategory: "export-completion" as const,
      phase: "decode" as const,
      category: "custom" as const,
      code: "user_id.non_positive",
      providerCode: "voyd.std.msgpack.decode",
      message: "user id must be positive",
      path: ["profile", "user_id"] as const,
    };
    const encoded = msgPackHostTransport.encodeFrame({
      kind: "export-completion",
      exportId: 7,
      outcome: { kind: "failure", failure },
    });
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer).set(encoded);

    expect(() =>
      decodeHostCompletion({
        memory,
        ptr: 0,
        length: encoded.length,
        transport: msgPackHostTransport,
        completion: { kind: "export", id: 7 },
      }),
    ).toThrowError(
      expect.objectContaining<Partial<HostFrameFailureError>>({
        failure,
      }),
    );
  });

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

    expect(
      encodeBoundaryArgs({
        exportName: "standalone variant",
        schemas: [
          {
            kind: "record",
            tag: "Some",
            fields: [{ name: "value", schema: { kind: "i32" } }],
          },
        ],
        args: [{ tag: "Some", value: 5 }],
      }),
    ).toEqual([{ $variant: "Some", value: 5 }]);
  });

  it("rejects unknown record fields and validates explicit null values", () => {
    const schema = {
      kind: "record" as const,
      fields: [
        {
          name: "name",
          optional: true,
          schema: { kind: "string" as const },
        },
      ],
    };

    expect(() =>
      encodeBoundaryArgs({
        exportName: "profile",
        schemas: [schema],
        args: [{ name: "Ada", typo: true }],
      }),
    ).toThrow("arg0 has unknown field typo");
    expect(() =>
      encodeBoundaryArgs({
        exportName: "profile",
        schemas: [schema],
        args: [{ name: null }],
      }),
    ).toThrow("arg0.name expected String, got null");
    expect(() =>
      decodeBoundaryResult({
        exportName: "profile",
        schema,
        value: { extra: 1 },
      }),
    ).toThrow("result has unknown field extra");
  });

  it("rejects DTO values beyond the host depth limit", () => {
    const schema = {
      kind: "record" as const,
      typeId: 1,
      fields: [
        {
          name: "next",
          optional: true,
          schema: { kind: "ref" as const, typeId: 1 },
        },
      ],
    };
    let value: Record<string, unknown> = {};
    for (let depth = 0; depth <= 128; depth += 1) {
      value = { next: value };
    }

    expect(() =>
      encodeBoundaryArgs({
        exportName: "deep",
        schemas: [schema],
        args: [value],
      }),
    ).toThrow("exceeds maximum DTO depth 128");
  });
});

describe("host transport negotiation", () => {
  it("selects an adapter only by the exact emitted identity and ABI versions", () => {
    const adapter = {
      id: "example.transport",
      version: 3,
      encodedPayloadSize: () => 1,
      encodeFrame: () => new Uint8Array([2]),
      decodeFrame: () => ({
        kind: "cancellation-acknowledgement" as const,
        operationId: 1,
        accepted: true,
      }),
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

describe("generic host runtime architecture", () => {
  it("keeps transport format dependencies at composition edges", () => {
    genericRuntimeFiles(SOURCE_ROOT).forEach((path) => {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/msgpack/iu);
    });
  });
});

describe("host ABI v2 frames", () => {
  it("round-trips every complete frame category through MessagePack", () => {
    const value = { fingerprint: "sha256:abc", value: { count: 2 } };
    const outcome = { kind: "success" as const, value };
    const frames: readonly HostFrame[] = [
      { kind: "export-invocation", exportId: 42, args: [value] },
      { kind: "export-completion", exportId: 42, outcome },
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
            direction: "vm->host",
            frameCategory: "external-completion",
            phase: "execute",
            category: "custom",
            code: "example.failure",
            providerCode: "example.provider.failure",
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
    expect(() => msgPackHostTransport.decodeFrame(encode([2, 99]))).toThrow(
      "Unknown Voyd host frame tag 99",
    );
  });

  it("detaches decoded bytes from reusable transport memory", () => {
    const encoded = msgPackHostTransport.encodeFrame({
      kind: "effect-outcome",
      requestId: 1,
      outcome: {
        kind: "success",
        value: {
          fingerprint: "sha256:bytes",
          value: new Uint8Array([1, 2, 3]),
        },
      },
    });
    const decoded = msgPackHostTransport.decodeFrame(encoded);
    encoded.fill(0);

    expect(decoded).toMatchObject({
      outcome: { value: { value: new Uint8Array([1, 2, 3]) } },
    });
  });
});
