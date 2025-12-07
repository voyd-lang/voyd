import { Buffer } from "node:buffer";
import type binaryen from "binaryen";
import { EFFECT_TABLE_EXPORT } from "../../effects/effect-table.js";
import type {
  EffectTableEffect,
  EffectTableOp,
} from "../../effects/effect-table-types.js";
import {
  EFFECT_ID_HELPER,
  EFFECT_OP_ID_HELPER,
  EFFECT_RESUME_KIND_HELPER,
  OUTCOME_TAG_HELPER,
  OUTCOME_UNWRAP_I32_HELPER,
} from "../../effects/runtime-helpers.js";
import { OUTCOME_TAGS, RESUME_KIND } from "../../effects/runtime-abi.js";

const TABLE_HEADER_SIZE = 12;
const EFFECT_HEADER_SIZE = 16;
const OP_ENTRY_SIZE = 12;

type WasmSource =
  | binaryen.Module
  | Uint8Array
  | ArrayBuffer
  | WebAssembly.Module;

export interface ParsedEffectTable {
  version: number;
  tableExport: string;
  names: Uint8Array;
  namesBase64: string;
  effects: EffectTableEffect[];
  opsByEffect: Map<number, EffectTableOp[]>;
}

export interface EffectHandlerRequest {
  effectId: number;
  opId: number;
  resumeKind: number;
  label: string;
  effectLabel: string;
}

export type EffectHandler = (
  request: EffectHandlerRequest
) => unknown | Promise<unknown>;

const toBytes = (wasm: WasmSource): Uint8Array => {
  if (wasm instanceof Uint8Array) return wasm;
  if (wasm instanceof ArrayBuffer) return new Uint8Array(wasm);
  if (typeof WebAssembly !== "undefined" && wasm instanceof WebAssembly.Module) {
    throw new Error("Cannot derive bytes from a compiled WebAssembly.Module");
  }
  if (typeof (wasm as binaryen.Module).emitBinary === "function") {
    return (wasm as binaryen.Module).emitBinary();
  }
  throw new Error("Unsupported wasm input");
};

const decodeName = (names: Uint8Array, offset: number): string => {
  if (offset < 0 || offset >= names.length) {
    throw new Error(`Name offset ${offset} is out of bounds`);
  }
  let cursor = offset;
  const bytes: number[] = [];
  while (cursor < names.length && names[cursor] !== 0) {
    bytes.push(names[cursor]);
    cursor += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};

export const parseEffectTable = (
  wasm: WasmSource,
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
  if (version !== 1) {
    throw new Error(`Unsupported effect table version ${version}`);
  }
  const effectCount = read();
  const opCount = read();

  const effectHeaders = Array.from({ length: effectCount }, () => ({
    effectId: read(),
    nameOffset: read(),
    opsOffset: read(),
    opCount: read(),
  }));

  const opEntries = Array.from({ length: opCount }, () => ({
    opId: read(),
    resumeKind: read(),
    nameOffset: read(),
  }));

  const namesStart =
    TABLE_HEADER_SIZE +
    effectHeaders.length * EFFECT_HEADER_SIZE +
    opEntries.length * OP_ENTRY_SIZE;
  if (namesStart > payload.length) {
    throw new Error("Effect table payload is truncated");
  }
  const names = payload.slice(namesStart);
  const namesBase64 = Buffer.from(names).toString("base64");

  const opsByEffect = new Map<number, EffectTableOp[]>();
  const effects: EffectTableEffect[] = effectHeaders.map((header) => {
    if (header.opsOffset % OP_ENTRY_SIZE !== 0) {
      throw new Error("Effect table op offset is misaligned");
    }
    const start = header.opsOffset / OP_ENTRY_SIZE;
    const end = start + header.opCount;
    if (end > opEntries.length) {
      throw new Error("Effect table op range exceeds table bounds");
    }
    const ops = opEntries.slice(start, end).map((op) => ({
        id: op.opId,
        name: decodeName(names, op.nameOffset),
        label: decodeName(names, op.nameOffset),
        resumeKind: op.resumeKind,
      }));
    opsByEffect.set(header.effectId, ops);
    return {
      id: header.effectId,
      name: decodeName(names, header.nameOffset),
      label: decodeName(names, header.nameOffset),
      ops,
    };
  });

  return {
    version,
    tableExport,
    names,
    namesBase64,
    effects,
    opsByEffect,
  };
};

export const instantiateEffectModule = ({
  wasm,
  imports = {},
  tableExport = EFFECT_TABLE_EXPORT,
}: {
  wasm: WasmSource;
  imports?: WebAssembly.Imports;
  tableExport?: string;
}): {
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
  table: ParsedEffectTable;
} => {
  const module =
    wasm instanceof WebAssembly.Module
      ? wasm
      : new WebAssembly.Module(toBytes(wasm));
  const table = parseEffectTable(module, tableExport);
  const instance = new WebAssembly.Instance(module, imports);
  return { module, instance, table };
};

const resumeKindName = (kind: number): string =>
  kind === RESUME_KIND.tail ? "tail" : "resume";

const lookupHandler = ({
  handlers,
  request,
}: {
  handlers?: Record<string, EffectHandler>;
  request: EffectHandlerRequest & { opLabel: string };
}): EffectHandler | undefined => {
  if (!handlers) return undefined;
  const kind = resumeKindName(request.resumeKind);
  return (
    handlers[`${request.effectId}:${request.opId}:${request.resumeKind}`] ??
    handlers[`${request.effectLabel}.${request.opLabel}/${kind}`] ??
    handlers[`${request.effectLabel}.${request.opLabel}`]
  );
};

export const runEffectfulExport = async <T = unknown>({
  wasm,
  exportName,
  valueType = "i32",
  handlers,
  imports,
  tableExport = EFFECT_TABLE_EXPORT,
}: {
  wasm: WasmSource;
  exportName: string;
  valueType?: "i32" | "none";
  handlers?: Record<string, EffectHandler>;
  imports?: WebAssembly.Imports;
  tableExport?: string;
}): Promise<{
  value: T;
  table: ParsedEffectTable;
  instance: WebAssembly.Instance;
}> => {
  const { instance, table } = instantiateEffectModule({
    wasm,
    imports,
    tableExport,
  });
  const target = instance.exports[exportName];
  if (typeof target !== "function") {
    throw new Error(`Missing export ${exportName}`);
  }
  const tagFn = instance.exports[OUTCOME_TAG_HELPER];
  if (typeof tagFn !== "function") {
    throw new Error(`Missing outcome helper export ${OUTCOME_TAG_HELPER}`);
  }
  const outcome =
    target.length > 0
      ? (target as CallableFunction)(null)
      : (target as CallableFunction)();
  const tag = (tagFn as CallableFunction)(outcome);
  if (tag === OUTCOME_TAGS.value) {
    if (valueType === "i32") {
      const unwrap = instance.exports[OUTCOME_UNWRAP_I32_HELPER];
      if (typeof unwrap !== "function") {
        throw new Error(
          `Missing outcome helper export ${OUTCOME_UNWRAP_I32_HELPER}`
        );
      }
      return {
        value: (unwrap as CallableFunction)(outcome) as T,
        table,
        instance,
      };
    }
    return { value: undefined as T, table, instance };
  }

  if (tag === OUTCOME_TAGS.effect) {
    const effectIdFn = instance.exports[EFFECT_ID_HELPER];
    const opIdFn = instance.exports[EFFECT_OP_ID_HELPER];
    const resumeKindFn = instance.exports[EFFECT_RESUME_KIND_HELPER];
    if (
      !effectIdFn ||
      !opIdFn ||
      !resumeKindFn ||
      typeof effectIdFn !== "function" ||
      typeof opIdFn !== "function" ||
      typeof resumeKindFn !== "function"
    ) {
      throw new Error("Missing effect request helper exports");
    }
    const effectId = (effectIdFn as CallableFunction)(outcome) as number;
    const opId = (opIdFn as CallableFunction)(outcome) as number;
    const resumeKind = (resumeKindFn as CallableFunction)(outcome) as number;
    const effect = table.effects.find((entry) => entry.id === effectId);
    const effectLabel = effect?.label ?? `effect#${effectId}`;
    const opLabel =
      effect?.ops.find((op) => op.id === opId)?.label ??
      `${effectLabel}.op#${opId}`;
    const handlerRequest = {
      effectId,
      opId,
      resumeKind,
      label: opLabel,
      effectLabel,
      opLabel,
    };
    const handler = lookupHandler({
      handlers,
      request: handlerRequest,
    });
    if (!handler) {
      throw new Error(
        `Unhandled effect ${opLabel} (${resumeKindName(resumeKind)})`
      );
    }
    const value = await handler(handlerRequest);
    return { value: value as T, table, instance };
  }

  throw new Error(`Unknown outcome tag ${tag}`);
};
