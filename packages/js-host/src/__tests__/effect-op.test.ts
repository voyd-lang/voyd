import { describe, expect, it } from "vitest";
import {
  buildEffectOpKey,
  buildParsedEffectOpMap,
  parseResumeKind,
  resolveParsedEffectOp,
  resumeKindName,
} from "../effect-op.js";
import type { ParsedEffectOp, ParsedEffectTable } from "../protocol/table.js";
import { RESUME_KIND } from "../runtime/constants.js";

const createOp = ({
  opIndex,
  opId,
  resumeKind = RESUME_KIND.resume,
  signatureHash = 1,
}: {
  opIndex: number;
  opId: number;
  resumeKind?: ParsedEffectOp["resumeKind"];
  signatureHash?: number;
}): ParsedEffectOp => ({
  opIndex,
  effectId: "com.example.async",
  effectIdHash: {
    low: 1,
    high: 0,
    value: 1n,
    hex: "0x0000000000000001",
  },
  opId,
  resumeKind,
  signatureHash,
  label: `Async.op${opId}`,
});

const createTable = (ops: ParsedEffectOp[]): ParsedEffectTable => ({
  version: 2,
  tableExport: "__voyd_effect_table",
  names: new Uint8Array(),
  namesBase64: "",
  ops,
  opsByEffectId: new Map([["com.example.async", ops]]),
});

describe("effect op helpers", () => {
  it("builds canonical keys for both numeric and string signature hashes", () => {
    expect(
      buildEffectOpKey({
        effectId: "com.example.async",
        opId: 3,
        signatureHash: 1,
      })
    ).toBe("com.example.async::3::0x00000001");

    expect(
      buildEffectOpKey({
        effectId: "com.example.async",
        opId: 3,
        signatureHash: "0x00000001",
      })
    ).toBe("com.example.async::3::0x00000001");
  });

  it("builds parsed-op maps using the same key format as registration", () => {
    const op = createOp({ opIndex: 0, opId: 7, signatureHash: 0x1a });
    const map = buildParsedEffectOpMap({ ops: [op] });
    const key = buildEffectOpKey({
      effectId: op.effectId,
      opId: op.opId,
      signatureHash: op.signatureHash,
    });

    expect(map.get(key)).toBe(op);
  });

  it("resolves ops from effect requests using handle-first lookup and validates payload", () => {
    const first = createOp({ opIndex: 0, opId: 10 });
    const second = createOp({
      opIndex: 1,
      opId: 11,
      resumeKind: RESUME_KIND.tail,
    });
    const table = createTable([first, second]);

    const resolved = resolveParsedEffectOp({
      table,
      request: {
        effectId: 1n,
        opId: 11,
        opIndex: 1,
        resumeKind: RESUME_KIND.tail,
        handle: 1,
      },
    });

    expect(resolved).toBe(second);
  });

  it("throws on unsupported resume kinds", () => {
    expect(() => parseResumeKind(99)).toThrow(/unsupported resume kind 99/);
  });

  it("formats resume kind labels", () => {
    expect(resumeKindName(RESUME_KIND.resume)).toBe("resume");
    expect(resumeKindName(RESUME_KIND.tail)).toBe("tail");
  });
});
