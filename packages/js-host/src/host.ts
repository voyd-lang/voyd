import type {
  EffectHandler,
  HostProtocolTable,
  SignatureHash,
} from "./protocol/types.js";
import { decode, encode } from "@msgpack/msgpack";
import { buildEffectOpKey, buildParsedEffectOpMap } from "./effect-op.js";
import {
  EFFECT_TABLE_EXPORT,
  parseEffectTable,
  toHostProtocolTable,
} from "./protocol/table.js";
import {
  EFFECTS_MEMORY_EXPORT,
  LINEAR_MEMORY_EXPORT,
  MIN_EFFECT_BUFFER_SIZE,
} from "./runtime/constants.js";
import { runEffectLoop } from "./runtime/dispatch.js";
import { ensureMemoryCapacity } from "./runtime/memory.js";
import type { ParsedEffectOp, ParsedEffectTable } from "./protocol/table.js";
import { registerHandlersByLabelSuffix } from "./handlers.js";
import { parseExportAbi } from "./protocol/export-abi.js";

export type HostInitOptions = {
  wasm: Uint8Array | WebAssembly.Module;
  imports?: WebAssembly.Imports;
  bufferSize?: number;
};

export type VoydHost = {
  table: HostProtocolTable;
  instance: WebAssembly.Instance;
  registerHandler: (
    effectId: string,
    opId: number,
    signatureHash: SignatureHash,
    handler: EffectHandler
  ) => void;
  registerHandlersByLabelSuffix: (
    handlersByLabelSuffix: Record<string, EffectHandler>
  ) => number;
  initEffects: () => void;
  runPure: <T = unknown>(entryName: string, args?: unknown[]) => Promise<T>;
  runEffectful: <T = unknown>(entryName: string, args?: unknown[]) => Promise<T>;
  run: <T = unknown>(entryName: string, args?: unknown[]) => Promise<T>;
};

const MSGPACK_OPTS = { useBigInt64: true } as const;

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const toModule = (wasm: Uint8Array | WebAssembly.Module): WebAssembly.Module =>
  wasm instanceof WebAssembly.Module
    ? wasm
    : new WebAssembly.Module(toArrayBuffer(wasm));

const requireExportedFunction = ({
  instance,
  name,
}: {
  instance: WebAssembly.Instance;
  name: string;
}): CallableFunction => {
  const fn = instance.exports[name];
  if (typeof fn !== "function") {
    throw new Error(`Missing export ${name}`);
  }
  return fn as CallableFunction;
};

const requireExportedMemory = ({
  instance,
  name,
}: {
  instance: WebAssembly.Instance;
  name: string;
}): WebAssembly.Memory => {
  const exported = instance.exports[name];
  if (!(exported instanceof WebAssembly.Memory)) {
    throw new Error(`expected module to export ${name}`);
  }
  return exported;
};

const effectfulExportNameFor = (entryName: string): string =>
  entryName.endsWith("_effectful") ? entryName : `${entryName}_effectful`;

const registerHandlerInternal = ({
  handler,
  signatureHash,
  effectId,
  opId,
  opByKey,
  handlersByKey,
}: {
  handler: EffectHandler;
  signatureHash: SignatureHash;
  effectId: string;
  opId: number;
  opByKey: Map<string, ParsedEffectOp>;
  handlersByKey: Map<string, EffectHandler>;
}): ParsedEffectOp => {
  const key = buildEffectOpKey({
    effectId,
    opId,
    signatureHash,
  });
  const opEntry = opByKey.get(key);
  if (!opEntry) {
    throw new Error(`Unknown effect op for ${key}`);
  }
  handlersByKey.set(key, handler);
  return opEntry;
};

const initEffectsInternal = ({
  instance,
  bufferSize,
  table,
  handlersByKey,
  handlersByOpIndex,
}: {
  instance: WebAssembly.Instance;
  bufferSize: number;
  table: ParsedEffectTable;
  handlersByKey: Map<string, EffectHandler>;
  handlersByOpIndex: Array<EffectHandler | undefined>;
}): void => {
  if (table.ops.length === 0) {
    return;
  }

  const effectsMemory = requireExportedMemory({
    instance,
    name: EFFECTS_MEMORY_EXPORT,
  });
  ensureMemoryCapacity({
    memory: effectsMemory,
    requiredBytes: table.ops.length * 4,
    label: EFFECTS_MEMORY_EXPORT,
  });

  const handleView = new DataView(effectsMemory.buffer);
  table.ops.forEach((op) => {
    const handle = op.opIndex;
    handleView.setUint32(op.opIndex * 4, handle, true);
    const key = buildEffectOpKey({
      effectId: op.effectId,
      opId: op.opId,
      signatureHash: op.signatureHash,
    });
    handlersByOpIndex[op.opIndex] = handlersByKey.get(key);
  });

  const initEffectsFn = requireExportedFunction({ instance, name: "init_effects" });
  initEffectsFn();

  ensureMemoryCapacity({
    memory: requireExportedMemory({ instance, name: LINEAR_MEMORY_EXPORT }),
    requiredBytes: bufferSize,
    label: LINEAR_MEMORY_EXPORT,
  });
};

export const createVoydHost = async ({
  wasm,
  imports,
  bufferSize = MIN_EFFECT_BUFFER_SIZE,
}: HostInitOptions): Promise<VoydHost> => {
  const module = toModule(wasm);
  const parsedTable = parseEffectTable(module, EFFECT_TABLE_EXPORT);
  const table = toHostProtocolTable(parsedTable);
  const exportAbi = parseExportAbi(module);
  const exportAbiByName = new Map(
    exportAbi.exports.map((entry) => [entry.name, entry] as const)
  );
  const instance = new WebAssembly.Instance(module, imports ?? {});

  const handlersByKey = new Map<string, EffectHandler>();
  const opByKey = buildParsedEffectOpMap({ ops: parsedTable.ops });

  let initialized = false;
  const handlersByOpIndex: Array<EffectHandler | undefined> = Array.from({
    length: parsedTable.ops.length,
  });

  const registerHandler = (
    effectId: string,
    opId: number,
    signatureHash: SignatureHash,
    handler: EffectHandler
  ): void => {
    const opEntry = registerHandlerInternal({
      handler,
      signatureHash,
      effectId,
      opId,
      opByKey,
      handlersByKey,
    });
    if (initialized) {
      handlersByOpIndex[opEntry.opIndex] = handler;
    }
  };

  const initEffects = (): void => {
    if (initialized) {
      return;
    }
    initEffectsInternal({
      instance,
      bufferSize,
      table: parsedTable,
      handlersByKey,
      handlersByOpIndex,
    });
    initialized = true;
  };

  const runSerialized = async <T = unknown>(
    entryName: string,
    args: unknown[] = []
  ): Promise<T> => {
    const entry = requireExportedFunction({ instance, name: entryName });
    const msgpackMemory = requireExportedMemory({
      instance,
      name: LINEAR_MEMORY_EXPORT,
    });
    ensureMemoryCapacity({
      memory: msgpackMemory,
      requiredBytes: bufferSize * 2,
      label: LINEAR_MEMORY_EXPORT,
    });

    const encodedArgs = encode(args, MSGPACK_OPTS) as Uint8Array;
    if (encodedArgs.length > bufferSize) {
      throw new Error("serialized args exceed buffer size");
    }
    const inPtr = 0;
    const outPtr = bufferSize;
    new Uint8Array(msgpackMemory.buffer, inPtr, encodedArgs.length).set(
      encodedArgs
    );
    const written = (entry as CallableFunction)(
      inPtr,
      encodedArgs.length,
      outPtr,
      bufferSize
    ) as number;
    if (written < 0) {
      throw new Error("serialized export encoding failed");
    }
    if (written > bufferSize) {
      throw new Error("serialized export payload exceeds buffer size");
    }
    const bytes = new Uint8Array(msgpackMemory.buffer, outPtr, written);
    return decode(bytes, MSGPACK_OPTS) as T;
  };

  const runPure = async <T = unknown>(
    entryName: string,
    args: unknown[] = []
  ): Promise<T> => {
    const abi = exportAbiByName.get(entryName);
    if (abi?.abi === "serialized") {
      if (abi.formatId !== "msgpack") {
        throw new Error(`unsupported serializer format ${abi.formatId}`);
      }
      return runSerialized<T>(entryName, args);
    }
    const entry = requireExportedFunction({ instance, name: entryName });
    return (entry as (...params: unknown[]) => T)(...args);
  };

  const runEffectful = async <T = unknown>(
    entryName: string,
    args: unknown[] = []
  ): Promise<T> => {
    if (args.length > 0) {
      throw new Error("effectful exports do not accept arguments yet");
    }
    if (!initialized) {
      initEffects();
    }

    const entry = requireExportedFunction({
      instance,
      name: effectfulExportNameFor(entryName),
    });
    const effectStatus = requireExportedFunction({
      instance,
      name: "effect_status",
    });
    const effectCont = requireExportedFunction({
      instance,
      name: "effect_cont",
    });
    const effectLen = requireExportedFunction({
      instance,
      name: "effect_len",
    });
    const resumeEffectful = requireExportedFunction({
      instance,
      name: "resume_effectful",
    });

    const msgpackMemory = requireExportedMemory({
      instance,
      name: LINEAR_MEMORY_EXPORT,
    });
    ensureMemoryCapacity({
      memory: msgpackMemory,
      requiredBytes: bufferSize,
      label: LINEAR_MEMORY_EXPORT,
    });

    return runEffectLoop<T>({
      entry,
      effectStatus,
      effectCont,
      effectLen,
      resumeEffectful,
      table: parsedTable,
      handlersByOpIndex,
      msgpackMemory,
      bufferPtr: 0,
      bufferSize,
    });
  };

  const run = async <T = unknown>(
    entryName: string,
    args: unknown[] = []
  ): Promise<T> => {
    const effectfulName = effectfulExportNameFor(entryName);
    const hasEffectful = typeof instance.exports[effectfulName] === "function";
    return hasEffectful ? runEffectful<T>(entryName, args) : runPure<T>(entryName, args);
  };

  return {
    table,
    instance,
    registerHandler,
    registerHandlersByLabelSuffix: (handlersByLabelSuffix) =>
      registerHandlersByLabelSuffix({
        host: { table, registerHandler },
        handlersByLabelSuffix,
      }),
    initEffects,
    runPure,
    runEffectful,
    run,
  };
};
