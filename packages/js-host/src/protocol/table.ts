import type { HostProtocolTable, ResumeKind } from "./types.js";
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

export type ParsedEffectOp = {
  opIndex: number;
  effectId: string;
  effectIdHash: EffectIdHash;
  opId: number;
  resumeKind: ResumeKind;
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

const toBytes = (wasm: Uint8Array | ArrayBuffer): Uint8Array =>
  wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);

const parseResumeKind = (value: number): ResumeKind => {
  if (value === RESUME_KIND.resume) return "resume";
  if (value === RESUME_KIND.tail) return "tail";
  throw new Error(`unsupported resume kind ${value}`);
};

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
  wasm: Uint8Array | ArrayBuffer | WebAssembly.Module,
  tableExport = EFFECT_TABLE_EXPORT
): ParsedEffectTable => {
  const module =
    wasm instanceof WebAssembly.Module
      ? wasm
      : new WebAssembly.Module(toBytes(wasm));
  const sections = WebAssembly.Module.customSections(module, tableExport);
  if (sections.length === 0) {
    throw new Error(`Missing effect table export ${tableExport}`);
  }
  const payload = new Uint8Array(sections[0]!);
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
  ops: table.ops.map((op) => ({
    opIndex: op.opIndex,
    effectId: op.effectId,
    opId: op.opId,
    resumeKind: op.resumeKind,
    signatureHash: formatSignatureHash(op.signatureHash),
    ...(op.label ? { label: op.label } : {}),
  })),
});
