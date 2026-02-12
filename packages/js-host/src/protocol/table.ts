import type { HostProtocolTable } from "./types.js";
import { RESUME_KIND } from "../runtime/constants.js";

const TABLE_HEADER_SIZE = 8;
const OP_ENTRY_SIZE = 28;
const TABLE_VERSION = 2;

export const EFFECT_TABLE_EXPORT = "__voyd_effect_table";

type EffectIdHash = {
  low: number;
  high: number;
  value: bigint;
  hex: string;
};

export type ResumeKindCode = (typeof RESUME_KIND)[keyof typeof RESUME_KIND];

export type ParsedEffectOp = {
  opIndex: number;
  effectId: string;
  effectIdHash: EffectIdHash;
  opId: number;
  resumeKind: ResumeKindCode;
  signatureHash: number;
  label: string;
};

export type ParsedEffectTable = {
  version: number;
  tableExport: string;
  names: Uint8Array;
  namesBase64: string;
  ops: ParsedEffectOp[];
  opsByEffectId: Map<string, ParsedEffectOp[]>;
};

const getBuffer = ():
  | { from(data: Uint8Array): { toString(encoding: "base64"): string } }
  | undefined => {
  const buffer = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  return buffer && typeof buffer.from === "function" ? buffer : undefined;
};

const getBtoa = (): ((data: string) => string) | undefined =>
  (globalThis as { btoa?: (data: string) => string }).btoa;

const toBinaryString = (data: Uint8Array): string => {
  let result = "";
  for (let index = 0; index < data.length; index += 1) {
    result += String.fromCharCode(data[index]!);
  }
  return result;
};

const toBase64 = (data: Uint8Array): string => {
  const buffer = getBuffer();
  if (buffer) {
    return buffer.from(data).toString("base64");
  }

  const btoa = getBtoa();
  if (btoa) {
    return btoa(toBinaryString(data));
  }

  throw new Error("Base64 encoding is unavailable in this environment");
};

type BinaryenModuleLike = { emitBinary: () => Uint8Array };

const toUint8Array = (
  wasm: Uint8Array | ArrayBuffer | BinaryenModuleLike
): Uint8Array => {
  if (wasm instanceof Uint8Array) return wasm;
  if (wasm instanceof ArrayBuffer) return new Uint8Array(wasm);
  if (typeof (wasm as BinaryenModuleLike).emitBinary === "function") {
    return toUint8Array((wasm as BinaryenModuleLike).emitBinary());
  }
  throw new Error("Unsupported wasm input");
};

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d] as const;
const WASM_VERSION_V1 = [0x01, 0x00, 0x00, 0x00] as const;
const WASM_HEADER_SIZE = 8;
const CUSTOM_SECTION_ID = 0;

const readVarUint32 = ({
  bytes,
  offset,
  context,
}: {
  bytes: Uint8Array;
  offset: number;
  context: string;
}): { value: number; nextOffset: number } => {
  let value = 0;
  let shift = 0;
  let cursor = offset;

  for (let index = 0; index < 5; index += 1) {
    if (cursor >= bytes.length) {
      throw new Error(`Truncated varuint32 while reading ${context}`);
    }

    const byte = bytes[cursor]!;
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: cursor };
    }
    shift += 7;
  }

  throw new Error(`Invalid varuint32 while reading ${context}`);
};

const ensureWasmHeader = (bytes: Uint8Array): void => {
  if (bytes.length < WASM_HEADER_SIZE) {
    throw new Error("Invalid wasm binary: missing header");
  }

  const hasMagic = WASM_MAGIC.every((byte, index) => bytes[index] === byte);
  const hasVersion = WASM_VERSION_V1.every(
    (byte, index) => bytes[index + WASM_MAGIC.length] === byte
  );

  if (!hasMagic || !hasVersion) {
    throw new Error("Invalid wasm binary header");
  }
};

const getCustomSectionPayloadFromBytes = ({
  wasmBytes,
  tableExport,
}: {
  wasmBytes: Uint8Array;
  tableExport: string;
}): Uint8Array | undefined => {
  ensureWasmHeader(wasmBytes);
  let offset = WASM_HEADER_SIZE;

  while (offset < wasmBytes.length) {
    const sectionId = wasmBytes[offset]!;
    offset += 1;
    const sectionSizeRead = readVarUint32({
      bytes: wasmBytes,
      offset,
      context: "section size",
    });
    offset = sectionSizeRead.nextOffset;
    const sectionEnd = offset + sectionSizeRead.value;
    if (sectionEnd > wasmBytes.length) {
      throw new Error("Wasm section is truncated");
    }

    if (sectionId === CUSTOM_SECTION_ID) {
      const sectionNameLengthRead = readVarUint32({
        bytes: wasmBytes,
        offset,
        context: "custom section name length",
      });
      const sectionNameStart = sectionNameLengthRead.nextOffset;
      const sectionNameEnd = sectionNameStart + sectionNameLengthRead.value;
      if (sectionNameEnd > sectionEnd) {
        throw new Error("Custom section name extends beyond section bounds");
      }

      const sectionName = new TextDecoder().decode(
        wasmBytes.subarray(sectionNameStart, sectionNameEnd)
      );
      if (sectionName === tableExport) {
        return wasmBytes.slice(sectionNameEnd, sectionEnd);
      }
    }

    offset = sectionEnd;
  }

  return undefined;
};

const parseResumeKind = (value: number): ResumeKindCode => {
  if (value === RESUME_KIND.resume) return RESUME_KIND.resume;
  if (value === RESUME_KIND.tail) return RESUME_KIND.tail;
  throw new Error(`unsupported resume kind ${value}`);
};

const resumeKindName = (value: ResumeKindCode): "resume" | "tail" =>
  value === RESUME_KIND.tail ? "tail" : "resume";

const decodeName = (names: Uint8Array, offset: number): string => {
  if (offset < 0 || offset >= names.length) {
    throw new Error(`Name offset ${offset} is out of bounds`);
  }
  let cursor = offset;
  const bytes: number[] = [];
  while (cursor < names.length && names[cursor] !== 0) {
    bytes.push(names[cursor]!);
    cursor += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};

const effectIdHashFromParts = (low: number, high: number): EffectIdHash => {
  const value = BigInt.asUintN(64, (BigInt(high) << 32n) | BigInt(low));
  return {
    low,
    high,
    value,
    hex: `0x${high.toString(16).padStart(8, "0")}${low
      .toString(16)
      .padStart(8, "0")}`,
  };
};

export const formatSignatureHash = (value: number): string =>
  `0x${value.toString(16).padStart(8, "0")}`;

const withDoubleColonOpSeparator = (label: string): string => {
  const opSeparator = label.lastIndexOf(".");
  if (opSeparator < 0) return label;
  return `${label.slice(0, opSeparator)}::${label.slice(opSeparator + 1)}`;
};

const opNameFromLabel = (label: string): string => {
  const opSeparator = label.lastIndexOf("::");
  if (opSeparator < 0) return label;
  return label.slice(opSeparator + 2);
};

export const normalizeSignatureHash = (hash: string): number => {
  const trimmed = hash.trim();
  if (!trimmed) {
    throw new Error("signature hash cannot be empty");
  }
  const isHex = trimmed.startsWith("0x") || trimmed.startsWith("0X");
  const raw = isHex ? trimmed.slice(2) : trimmed;
  const value = Number.parseInt(raw, isHex ? 16 : 10);
  if (!Number.isFinite(value)) {
    throw new Error(`invalid signature hash ${hash}`);
  }
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`signature hash out of range: ${hash}`);
  }
  return value >>> 0;
};

export const parseEffectTable = (
  wasm: Uint8Array | ArrayBuffer | WebAssembly.Module | BinaryenModuleLike,
  tableExport = EFFECT_TABLE_EXPORT
): ParsedEffectTable => {
  const payload =
    wasm instanceof WebAssembly.Module
      ? (() => {
          const sections = WebAssembly.Module.customSections(wasm, tableExport);
          if (sections.length === 0) return undefined;
          return new Uint8Array(sections[0]!);
        })()
      : getCustomSectionPayloadFromBytes({
          wasmBytes: toUint8Array(wasm),
          tableExport,
        });

  if (!payload) {
    throw new Error(`Missing effect table export ${tableExport}`);
  }

  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength
  );
  let offset = 0;
  const read = () => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };

  const version = read();
  if (version !== TABLE_VERSION) {
    throw new Error(`Unsupported effect table version ${version}`);
  }
  const opCount = read();

  const opEntries = Array.from({ length: opCount }, (_value, opIndex) => ({
    opIndex,
    effectIdLo: read(),
    effectIdHi: read(),
    effectIdNameOffset: read(),
    opId: read(),
    resumeKind: read(),
    signatureHash: read(),
    labelOffset: read(),
  }));

  const namesStart = TABLE_HEADER_SIZE + opEntries.length * OP_ENTRY_SIZE;
  if (namesStart > payload.length) {
    throw new Error("Effect table payload is truncated");
  }
  const names = payload.slice(namesStart);
  const namesBase64 = toBase64(names);

  const ops: ParsedEffectOp[] = opEntries.map((entry) => {
    const effectId = decodeName(names, entry.effectIdNameOffset);
    return {
      opIndex: entry.opIndex,
      effectId,
      effectIdHash: effectIdHashFromParts(entry.effectIdLo, entry.effectIdHi),
      opId: entry.opId,
      resumeKind: parseResumeKind(entry.resumeKind),
      signatureHash: entry.signatureHash,
      label: decodeName(names, entry.labelOffset),
    };
  });

  const opsByEffectId = new Map<string, ParsedEffectOp[]>();
  ops.forEach((op) => {
    const bucket = opsByEffectId.get(op.effectId) ?? [];
    bucket.push(op);
    opsByEffectId.set(op.effectId, bucket);
  });

  return {
    version,
    tableExport,
    names,
    namesBase64,
    ops,
    opsByEffectId,
  };
};

export const toHostProtocolTable = (
  table: ParsedEffectTable
): HostProtocolTable => ({
  version: table.version,
  ops: table.ops.map((op) => {
    const label = withDoubleColonOpSeparator(op.label);
    return {
      opIndex: op.opIndex,
      effectId: op.effectId,
      opId: op.opId,
      opName: opNameFromLabel(label),
      resumeKind: resumeKindName(op.resumeKind),
      signatureHash: formatSignatureHash(op.signatureHash),
      ...(label ? { label } : {}),
    };
  }),
});
