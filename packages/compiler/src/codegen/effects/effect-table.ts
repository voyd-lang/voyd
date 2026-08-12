import binaryen from "binaryen";
import type { CodegenContext } from "../context.js";
import type { EffectTableSidecar } from "./effect-table-types.js";
import type { EffectRegistry } from "./effect-registry.js";
import { toBase64 } from "./base64.js";

const TABLE_VERSION_V2 = 2;
const TABLE_VERSION = 3;
export const EFFECT_TABLE_EXPORT = "__voyd_effect_table";
export const EFFECT_ABI_SECTION = "voyd.effect_abi";

const TABLE_HEADER_SIZE = 8; // version + opCount (u32 each)
const OP_ENTRY_SIZE_V2 = 28; // effectIdLo, effectIdHi, effectIdName, opId, resumeKind, signatureHash, label (u32 each)
const OP_ENTRY_SIZE = 32; // effectIdLo, effectIdHi, effectIdName, opId, resumeKind, signatureHash, label, operationId (u32 each)

interface OpEntry {
  effectIdLo: number;
  effectIdHi: number;
  effectIdNameOffset: number;
  opId: number;
  resumeKind: number;
  signatureHash: number;
  labelOffset: number;
  operationIdOffset?: number;
}

class NamesBlobBuilder {
  private readonly offsets = new Map<string, number>();
  private readonly bytes: number[] = [];
  private readonly encoder = new TextEncoder();

  intern(value: string): number {
    const cached = this.offsets.get(value);
    if (typeof cached === "number") return cached;
    const offset = this.bytes.length;
    const encoded = this.encoder.encode(value);
    this.bytes.push(...encoded, 0); // null-terminated for easy traversal
    this.offsets.set(value, offset);
    return offset;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

const formatEffectIdHash = (low: number, high: number): string =>
  `0x${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;

export const emitEffectTableSection = ({
  contexts,
  entryModuleId,
  mod,
  exportName = EFFECT_TABLE_EXPORT,
  registry,
}: {
  contexts: readonly CodegenContext[];
  entryModuleId: string;
  mod: binaryen.Module;
  exportName?: string;
  registry?: EffectRegistry;
}): EffectTableSidecar => {
  const first = contexts[0];
  if (!first) {
    throw new Error("emitEffectTableSection requires at least one context");
  }
  const effectRegistry = registry ?? first.effectsState.effectRegistry;
  if (!effectRegistry) {
    throw new Error("missing effect registry");
  }

  const names = new NamesBlobBuilder();
  const version = effectRegistry.entries.some((entry) => entry.operationId)
    ? TABLE_VERSION
    : TABLE_VERSION_V2;
  const opEntries: OpEntry[] = effectRegistry.entries.map((entry) => ({
    effectIdLo: entry.effectId.hash.low,
    effectIdHi: entry.effectId.hash.high,
    effectIdNameOffset: names.intern(entry.effectId.id),
    opId: entry.opId,
    resumeKind: entry.resumeKind,
    signatureHash: entry.signatureHash,
    labelOffset: names.intern(entry.label),
    ...(version === TABLE_VERSION
      ? { operationIdOffset: names.intern(entry.operationId ?? "") }
      : {}),
  }));

  const namesBlob = names.finish();
  const entrySize =
    version === TABLE_VERSION ? OP_ENTRY_SIZE : OP_ENTRY_SIZE_V2;
  const namesStart = TABLE_HEADER_SIZE + opEntries.length * entrySize;
  const buffer = new ArrayBuffer(namesStart + namesBlob.byteLength);
  const view = new DataView(buffer);
  let offset = 0;

  const write = (value: number) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };

  write(version);
  write(opEntries.length);

  opEntries.forEach((entry) => {
    write(entry.effectIdLo);
    write(entry.effectIdHi);
    write(entry.effectIdNameOffset);
    write(entry.opId);
    write(entry.resumeKind);
    write(entry.signatureHash);
    write(entry.labelOffset);
    if (version === TABLE_VERSION) {
      write(entry.operationIdOffset ?? 0);
    }
  });

  new Uint8Array(buffer, namesStart).set(namesBlob);
  const sectionBytes = new Uint8Array(buffer);
  mod.addCustomSection(exportName, sectionBytes);
  const boundaryOps = effectRegistry.entries.flatMap((entry) =>
    entry.boundary && effectRegistry.usedOpIndexes.has(entry.opIndex)
      ? [
          {
            opIndex: entry.opIndex,
            params: entry.boundary.params,
            result: entry.boundary.result,
          },
        ]
      : [],
  );
  if (boundaryOps.length > 0) {
    mod.addCustomSection(
      EFFECT_ABI_SECTION,
      new TextEncoder().encode(
        JSON.stringify({ version: 1, ops: boundaryOps }),
      ),
    );
  }

  return {
    version,
    moduleId: entryModuleId,
    tableExport: exportName,
    namesBlob: toBase64(namesBlob),
    ops: effectRegistry.entries.map((entry) => ({
      opIndex: entry.opIndex,
      effectId: entry.effectId.id,
      effectIdHash: formatEffectIdHash(
        entry.effectId.hash.low,
        entry.effectId.hash.high,
      ),
      opId: entry.opId,
      ...(entry.operationId ? { operationId: entry.operationId } : {}),
      resumeKind: entry.resumeKind,
      signatureHash: entry.signatureHash,
      label: entry.label,
    })),
  };
};
