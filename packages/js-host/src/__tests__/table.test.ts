import { describe, expect, it } from "vitest";
import { parseEffectTable, type ParsedEffectTable } from "../protocol/table.js";
import { RESUME_KIND } from "../runtime/constants.js";

const encoder = new TextEncoder();

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    out.set(chunk, offset);
    offset += chunk.length;
  });
  return out;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
};

const encodeU32LE = (value: number): Uint8Array =>
  new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);

const encodeVarUint32 = (value: number): Uint8Array => {
  if (value < 0 || !Number.isInteger(value)) {
    throw new Error("varuint32 value must be a non-negative integer");
  }
  const bytes: number[] = [];
  let remaining = value >>> 0;
  while (true) {
    const chunk = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining === 0) {
      bytes.push(chunk);
      return new Uint8Array(bytes);
    }
    bytes.push(chunk | 0x80);
  }
};

const createEffectTablePayload = (): Uint8Array => {
  const effectId = encoder.encode("com.example.async");
  const label = encoder.encode("Async.await");
  const names = concat([effectId, Uint8Array.of(0), label, Uint8Array.of(0)]);

  const effectIdOffset = 0;
  const labelOffset = effectId.length + 1;

  return concat([
    encodeU32LE(2), // version
    encodeU32LE(1), // op count
    encodeU32LE(0x34), // effect id hash low
    encodeU32LE(0x12), // effect id hash high
    encodeU32LE(effectIdOffset),
    encodeU32LE(7), // op id
    encodeU32LE(RESUME_KIND.resume),
    encodeU32LE(0xface), // signature hash
    encodeU32LE(labelOffset),
    names,
  ]);
};

const createCustomSection = ({
  name,
  payload,
}: {
  name: string;
  payload: Uint8Array;
}): Uint8Array => {
  const nameBytes = encoder.encode(name);
  const sectionPayload = concat([
    encodeVarUint32(nameBytes.length),
    nameBytes,
    payload,
  ]);
  return concat([
    Uint8Array.of(0), // custom section id
    encodeVarUint32(sectionPayload.length),
    sectionPayload,
  ]);
};

const createInvalidWasmWithEffectTable = (): Uint8Array => {
  const header = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
  const customSection = createCustomSection({
    name: "__voyd_effect_table",
    payload: createEffectTablePayload(),
  });
  // Type section with invalid type byte (0x50 instead of 0x60).
  const invalidTypeSection = Uint8Array.of(0x01, 0x02, 0x01, 0x50);
  return concat([header, customSection, invalidTypeSection]);
};

const expectSingleParsedOp = (table: ParsedEffectTable): void => {
  expect(table.version).toBe(2);
  expect(table.ops).toHaveLength(1);
  const [op] = table.ops;
  expect(op?.effectId).toBe("com.example.async");
  expect(op?.opId).toBe(7);
  expect(op?.resumeKind).toBe(RESUME_KIND.resume);
  expect(op?.signatureHash).toBe(0xface);
  expect(op?.label).toBe("Async.await");
};

describe("parseEffectTable", () => {
  it("parses effect table custom sections from raw bytes without wasm validation", () => {
    const wasm = createInvalidWasmWithEffectTable();
    expect(() => new WebAssembly.Module(toArrayBuffer(wasm))).toThrow();

    const parsed = parseEffectTable(wasm);
    expectSingleParsedOp(parsed);
  });

  it("parses effect table from WebAssembly.Module inputs", () => {
    const header = Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
    const customSection = createCustomSection({
      name: "__voyd_effect_table",
      payload: createEffectTablePayload(),
    });
    const module = new WebAssembly.Module(
      toArrayBuffer(concat([header, customSection]))
    );

    const parsed = parseEffectTable(module);
    expectSingleParsedOp(parsed);
  });
});
