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

const toBytes = (
  wasm: Uint8Array | ArrayBuffer | BinaryenModuleLike
): Uint8Array => {
  if (wasm instanceof Uint8Array) return wasm;
  if (wasm instanceof ArrayBuffer) return new Uint8Array(wasm);
  if (typeof (wasm as BinaryenModuleLike).emitBinary === "function") {
    return (wasm as BinaryenModuleLike).emitBinary();
  }
  throw new Error("Unsupported wasm input");
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
    resumeKind: resumeKindName(op.resumeKind),
    signatureHash: formatSignatureHash(op.signatureHash),
    ...(op.label ? { label: op.label } : {}),
  })),
});
