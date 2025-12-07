import { Buffer } from "node:buffer";
import binaryen from "binaryen";
import type { CodegenContext } from "../context.js";
import { RESUME_KIND } from "./runtime-abi.js";
import type {
  EffectTableEffect,
  EffectTableOp,
  EffectTableSidecar,
} from "./effect-table-types.js";

const TABLE_VERSION = 1;
export const EFFECT_TABLE_EXPORT = "__voyd_effect_table";

const TABLE_HEADER_SIZE = 12; // version + effectCount + opCount (u32 each)
const EFFECT_HEADER_SIZE = 16; // effectId, nameOffset, opsOffset, opCount (u32 each)
const OP_ENTRY_SIZE = 12; // opId, resumeKind, nameOffset (u32 each)

interface EffectHeader {
  effectId: number;
  nameOffset: number;
  opsOffset: number;
  opCount: number;
}

interface OpEntry {
  opId: number;
  resumeKind: number;
  nameOffset: number;
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

const opResumeKind = (resumable: "resume" | "tail"): number =>
  resumable === "tail" ? RESUME_KIND.tail : RESUME_KIND.resume;

const collectEffects = (
  contexts: readonly CodegenContext[]
): EffectTableEffect[] => {
  const effects: EffectTableEffect[] = [];
  contexts.forEach((ctx) => {
    ctx.binding.effects.forEach((effect) => {
      const effectId = effects.length;
      const label = `${ctx.moduleLabel}::${effect.name}`;
      const ops: EffectTableOp[] = effect.operations.map((op, index) => ({
        id: index,
        name: op.name,
        label: `${label}.${op.name}`,
        resumeKind: opResumeKind(op.resumable),
      }));
      effects.push({
        id: effectId,
        name: effect.name,
        label,
        ops,
      });
    });
  });
  return effects;
};

const writeEffectTableBytes = ({
  effects,
  mod,
  exportName,
}: {
  effects: readonly EffectTableEffect[];
  mod: binaryen.Module;
  exportName: string;
}): { sectionBytes: Uint8Array; namesBlob: Uint8Array } => {
  const names = new NamesBlobBuilder();
  const effectHeaders: EffectHeader[] = [];
  const opEntries: OpEntry[] = [];

  effects.forEach((effect) => {
    const nameOffset = names.intern(effect.label);
    const opsOffset = opEntries.length * OP_ENTRY_SIZE;
    effect.ops.forEach((op) => {
      opEntries.push({
        opId: op.id,
        resumeKind: op.resumeKind,
        nameOffset: names.intern(op.label),
      });
    });
    effectHeaders.push({
      effectId: effect.id,
      nameOffset,
      opsOffset,
      opCount: effect.ops.length,
    });
  });

  const namesBlob = names.finish();
  const namesStart =
    TABLE_HEADER_SIZE +
    effectHeaders.length * EFFECT_HEADER_SIZE +
    opEntries.length * OP_ENTRY_SIZE;
  const buffer = new ArrayBuffer(namesStart + namesBlob.byteLength);
  const view = new DataView(buffer);
  let offset = 0;

  const write = (value: number) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };

  write(TABLE_VERSION);
  write(effectHeaders.length);
  write(opEntries.length);

  effectHeaders.forEach((header) => {
    write(header.effectId);
    write(header.nameOffset);
    write(header.opsOffset);
    write(header.opCount);
  });

  opEntries.forEach((entry) => {
    write(entry.opId);
    write(entry.resumeKind);
    write(entry.nameOffset);
  });

  new Uint8Array(buffer, namesStart).set(namesBlob);

  const sectionBytes = new Uint8Array(buffer);
  mod.addCustomSection(exportName, sectionBytes);
  return { sectionBytes, namesBlob };
};

export const emitEffectTableSection = ({
  contexts,
  entryModuleId,
  mod,
  exportName = EFFECT_TABLE_EXPORT,
}: {
  contexts: readonly CodegenContext[];
  entryModuleId: string;
  mod: binaryen.Module;
  exportName?: string;
}): EffectTableSidecar => {
  const effects = collectEffects(contexts);
  const { namesBlob } = writeEffectTableBytes({ effects, mod, exportName });

  return {
    version: TABLE_VERSION,
    moduleId: entryModuleId,
    tableExport: exportName,
    namesBlob: Buffer.from(namesBlob).toString("base64"),
    effects: effects.map((effect) => ({
      id: effect.id,
      name: effect.name,
      label: effect.label,
      ops: effect.ops.map((op) => ({
        id: op.id,
        name: op.name,
        label: op.label,
        resumeKind: op.resumeKind,
      })),
    })),
  };
};
