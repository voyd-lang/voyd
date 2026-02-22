import { describe, expect, it, vi } from "vitest";
import type { HostProtocolTable } from "../protocol/types.js";
import {
  buildHandlerKey,
  parseHandlerKey,
  registerHandlersByKey,
  resolveEffectOp,
  resolveSignatureHashForOp,
} from "../keyed-handlers.js";

const createTable = (): HostProtocolTable => ({
  version: 2,
  ops: [
    {
      opIndex: 0,
      effectId: "com.example.async",
      opId: 0,
      opName: "await",
      resumeKind: "resume",
      signatureHash: "0x00000011",
      label: "com.example.async::await",
    },
    {
      opIndex: 1,
      effectId: "com.example.async",
      opId: 1,
      opName: "await",
      resumeKind: "resume",
      signatureHash: "0x00000012",
      label: "com.example.async::await",
    },
    {
      opIndex: 2,
      effectId: "com.example.async",
      opId: 2,
      opName: "sleep",
      resumeKind: "resume",
      signatureHash: "0x00000013",
      label: "com.example.async::sleep",
    },
  ],
});

describe("parseHandlerKey", () => {
  it("parses effectId::opName keys", () => {
    expect(parseHandlerKey("com.example.async::sleep")).toEqual({
      effectId: "com.example.async",
      opName: "sleep",
    });
  });

  it("normalizes decimal or hex signature hashes", () => {
    expect(parseHandlerKey("com.example.async::await::18")).toEqual({
      effectId: "com.example.async",
      opName: "await",
      signatureHash: "0x00000012",
    });
    expect(parseHandlerKey("com.example.async::await::0x12")).toEqual({
      effectId: "com.example.async",
      opName: "await",
      signatureHash: "0x00000012",
    });
  });

  it("throws on invalid handler keys", () => {
    expect(() => parseHandlerKey("invalid")).toThrowError(
      "Invalid handler key invalid. Expected effectId::opName or effectId::opName::signatureHash"
    );
  });
});

describe("resolveEffectOp", () => {
  it("resolves unique ops without a signature", () => {
    const table = createTable();
    const op = resolveEffectOp({
      table,
      effectId: "com.example.async",
      opName: "sleep",
    });

    expect(op.opId).toBe(2);
    expect(op.signatureHash).toBe("0x00000013");
  });

  it("throws an ambiguity error for overloaded ops without a signature", () => {
    const table = createTable();
    expect(() =>
      resolveEffectOp({
        table,
        effectId: "com.example.async",
        opName: "await",
        key: "com.example.async::await",
      })
    ).toThrowError(
      "Ambiguous handler key com.example.async::await. com.example.async::await has multiple signatures (0x00000011, 0x00000012). Include signature hash."
    );
  });

  it("throws unknown-op errors with known op names", () => {
    const table = createTable();
    expect(() =>
      resolveEffectOp({
        table,
        effectId: "com.example.async",
        opName: "missing",
      })
    ).toThrowError(
      "Unknown effect op for com.example.async::missing. Known ops: await, sleep"
    );
  });

  it("throws unknown-op errors with known signatures when signature does not match", () => {
    const table = createTable();
    expect(() =>
      resolveEffectOp({
        table,
        effectId: "com.example.async",
        opName: "await",
        signatureHash: "0x99",
      })
    ).toThrowError(
      "Unknown effect op for com.example.async::await::0x00000099. Known signatures: 0x00000011, 0x00000012"
    );
  });
});

describe("resolveSignatureHashForOp", () => {
  it("resolves the signature hash for a unique op", () => {
    const table = createTable();
    const signatureHash = resolveSignatureHashForOp({
      table,
      effectId: "com.example.async",
      opName: "sleep",
    });

    expect(signatureHash).toBe("0x00000013");
  });
});

describe("buildHandlerKey", () => {
  it("includes normalized signatures when provided", () => {
    expect(
      buildHandlerKey({
        effectId: "com.example.async",
        opName: "await",
        signatureHash: "18",
      })
    ).toBe("com.example.async::await::0x00000012");
  });
});

describe("registerHandlersByKey", () => {
  it("registers handlers using resolved effect ops", () => {
    const table = createTable();
    const registerHandler = vi.fn();
    const awaitHandler = vi.fn();
    const sleepHandler = vi.fn();

    const count = registerHandlersByKey({
      host: { table, registerHandler },
      handlers: {
        "com.example.async::await::18": awaitHandler,
        "com.example.async::sleep": sleepHandler,
      },
    });

    expect(count).toBe(2);
    expect(registerHandler).toHaveBeenCalledTimes(2);
    expect(registerHandler).toHaveBeenCalledWith(
      "com.example.async",
      1,
      "0x00000012",
      awaitHandler
    );
    expect(registerHandler).toHaveBeenCalledWith(
      "com.example.async",
      2,
      "0x00000013",
      sleepHandler
    );
  });
});
