import type {
  EffectHandler,
  HostProtocolTable,
  RunOutcome,
  SignatureHash,
  VoydRunHandle,
} from "./protocol/types.js";
import { decode, encode } from "@msgpack/msgpack";
import { buildEffectOpKey, buildParsedEffectOpMap } from "./effect-op.js";
import {
  EFFECT_TABLE_EXPORT,
  parseEffectTable,
  toHostProtocolTable,
} from "./protocol/table.js";
import {
  LINEAR_MEMORY_EXPORT,
  MIN_EFFECT_BUFFER_SIZE,
} from "./runtime/constants.js";
import { continueEffectLoopStep } from "./runtime/dispatch.js";
import { ensureMemoryCapacity } from "./runtime/memory.js";
import type { ParsedEffectOp, ParsedEffectTable } from "./protocol/table.js";
import { registerHandlersByLabelSuffix } from "./handlers.js";
import { parseExportAbi } from "./protocol/export-abi.js";
import {
  createRuntimeScheduler,
  type RuntimeSchedulerOptions,
} from "./runtime/scheduler.js";
import {
  registerDefaultHostAdapters,
  type DefaultAdapterOptions,
  type DefaultAdapterRegistration,
} from "./adapters/default.js";
import { detectHostRuntime, scheduleTaskForRuntime } from "./runtime/environment.js";
import {
  createVoydTrapDiagnostics,
  type VoydTrapAnnotation,
} from "./runtime/trap-diagnostics.js";

export type HostInitOptions = {
  wasm: Uint8Array | WebAssembly.Module;
  imports?: WebAssembly.Imports;
  bufferSize?: number;
  scheduler?: RuntimeSchedulerOptions;
  defaultAdapters?: boolean | DefaultAdapterOptions;
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
  registerDefaultAdapters: (
    options?: DefaultAdapterOptions
  ) => Promise<DefaultAdapterRegistration>;
  initEffects: () => void;
  runPure: <T = unknown>(entryName: string, args?: unknown[]) => Promise<T>;
  runEffectfulManaged: <T = unknown>(
    entryName: string,
    args?: unknown[]
  ) => VoydRunHandle<T>;
  runManaged: <T = unknown>(entryName: string, args?: unknown[]) => VoydRunHandle<T>;
  runEffectful: <T = unknown>(entryName: string, args?: unknown[]) => Promise<T>;
  run: <T = unknown>(entryName: string, args?: unknown[]) => Promise<T>;
};

const MSGPACK_OPTS = { useBigInt64: true } as const;
let detachedRunCounter = 1;

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export class CancelledRunError extends Error {
  readonly reason?: unknown;

  constructor(reason?: unknown) {
    super("Run cancelled");
    this.name = "CancelledRunError";
    this.reason = reason;
  }
}

const unwrapRunOutcome = async <T>(outcome: Promise<RunOutcome<T>>): Promise<T> => {
  const settled = await outcome;
  if (settled.kind === "value") return settled.value;
  if (settled.kind === "failed") throw settled.error;
  throw new CancelledRunError(settled.reason);
};

const createVoydMathImports = (): Record<string, CallableFunction> => ({
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  exp: Math.exp,
  pow: Math.pow,
  atan2: Math.atan2,
});

const defaultImports = (): WebAssembly.Imports => ({
  env: {},
  voyd_math: createVoydMathImports(),
});

const isImportModuleRecord = (
  value: unknown
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const mergeDefaultImports = (
  imports?: WebAssembly.Imports
): WebAssembly.Imports => {
  const defaults = defaultImports() as Record<string, unknown>;
  if (!imports) {
    return defaults as WebAssembly.Imports;
  }
  const merged = {
    ...defaults,
    ...(imports as Record<string, unknown>),
  } as Record<string, unknown>;

  const importRecord = imports as Record<string, unknown>;
  ["env", "voyd_math"].forEach((moduleName) => {
    const defaultModule = defaults[moduleName];
    const providedModule = importRecord[moduleName];
    if (
      isImportModuleRecord(defaultModule) &&
      isImportModuleRecord(providedModule)
    ) {
      merged[moduleName] = { ...defaultModule, ...providedModule };
    }
  });

  return merged as WebAssembly.Imports;
};

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

const handleTableBasePtr = (bufferSize: number): number => bufferSize * 2;
const alignTo = (value: number, alignment: number): number =>
  Math.ceil(value / alignment) * alignment;

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

  const tablePtr = handleTableBasePtr(bufferSize);
  const linearMemory = requireExportedMemory({
    instance,
    name: LINEAR_MEMORY_EXPORT,
  });
  ensureMemoryCapacity({
    memory: linearMemory,
    requiredBytes: tablePtr + table.ops.length * 4,
    label: LINEAR_MEMORY_EXPORT,
  });

  const handleView = new DataView(linearMemory.buffer);
  table.ops.forEach((op) => {
    const handle = op.opIndex;
    handleView.setUint32(tablePtr + op.opIndex * 4, handle, true);
    const key = buildEffectOpKey({
      effectId: op.effectId,
      opId: op.opId,
      signatureHash: op.signatureHash,
    });
    handlersByOpIndex[op.opIndex] = handlersByKey.get(key);
  });

  const initEffectsFn = requireExportedFunction({ instance, name: "init_effects" });
  initEffectsFn(tablePtr);
};

export const createVoydHost = async ({
  wasm,
  imports,
  bufferSize = MIN_EFFECT_BUFFER_SIZE,
  scheduler,
  defaultAdapters = true,
}: HostInitOptions): Promise<VoydHost> => {
  const module = toModule(wasm);
  const trapDiagnostics = createVoydTrapDiagnostics({ module });
  const annotateTrap = (
    error: unknown,
    opts?: VoydTrapAnnotation
  ): Error => trapDiagnostics.annotateTrap(error, opts);
  const parsedTable = parseEffectTable(module, EFFECT_TABLE_EXPORT);
  const table = toHostProtocolTable(parsedTable);
  const exportAbi = parseExportAbi(module);
  const exportAbiByName = new Map(
    exportAbi.exports.map((entry) => [entry.name, entry] as const)
  );
  const instance = new WebAssembly.Instance(module, mergeDefaultImports(imports));

  const handlersByKey = new Map<string, EffectHandler>();
  const opByKey = buildParsedEffectOpMap({ ops: parsedTable.ops });
  const runtime = detectHostRuntime();
  const runtimeScheduler = createRuntimeScheduler({
    ...scheduler,
    scheduleTask: scheduler?.scheduleTask ?? scheduleTaskForRuntime(runtime),
  });
  const effectRunBufferBasePtr = alignTo(
    handleTableBasePtr(bufferSize) + parsedTable.ops.length * 4,
    8
  );
  const freeEffectRunBufferPtrs: number[] = [];
  let nextEffectRunBufferPtr = effectRunBufferBasePtr;

  const acquireEffectRunBufferPtr = (): number => {
    const recycled = freeEffectRunBufferPtrs.pop();
    if (recycled !== undefined) {
      return recycled;
    }
    const ptr = nextEffectRunBufferPtr;
    nextEffectRunBufferPtr += bufferSize;
    return ptr;
  };

  const releaseEffectRunBufferPtr = (bufferPtr: number): void => {
    freeEffectRunBufferPtrs.push(bufferPtr);
  };

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
    let written: number;
    try {
      written = (entry as CallableFunction)(
        inPtr,
        encodedArgs.length,
        outPtr,
        bufferSize
      ) as number;
    } catch (error) {
      throw annotateTrap(error, {
        transition: {
          point: "run_serialized_entry",
          direction: "host->vm",
        },
        fallbackFunctionName: entryName,
      });
    }
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
    try {
      return (entry as (...params: unknown[]) => T)(...args);
    } catch (error) {
      throw annotateTrap(error, {
        transition: {
          point: "run_pure_entry",
          direction: "host->vm",
        },
        fallbackFunctionName: entryName,
      });
    }
  };

  const runEffectfulManaged = <T = unknown>(
    entryName: string,
    args: unknown[] = []
  ): VoydRunHandle<T> => {
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
    const bufferPtr = acquireEffectRunBufferPtr();
    ensureMemoryCapacity({
      memory: msgpackMemory,
      requiredBytes: bufferPtr + bufferSize,
      label: LINEAR_MEMORY_EXPORT,
    });

    const run = runtimeScheduler.startRun<T>({
      start: () => {
        try {
          return entry(bufferPtr, bufferSize);
        } catch (error) {
          throw annotateTrap(error, {
            transition: {
              point: "effectful_entry",
              direction: "host->vm",
            },
            fallbackFunctionName: entryName,
          });
        }
      },
      step: async (result, context) =>
        continueEffectLoopStep<T>({
          result,
          effectStatus,
          effectCont,
          effectLen,
          resumeEffectful,
          table: parsedTable,
          handlersByOpIndex,
          msgpackMemory,
          bufferPtr,
          bufferSize,
          shouldContinue: () => !context.isCancelled(),
          annotateTrap,
          fallbackFunctionName: entryName,
        }),
    });
    void run.outcome.finally(() => {
      releaseEffectRunBufferPtr(bufferPtr);
    });
    return run;
  };

  const runManaged = <T = unknown>(
    entryName: string,
    args: unknown[] = []
  ): VoydRunHandle<T> => {
    const effectfulName = effectfulExportNameFor(entryName);
    const hasEffectful = typeof instance.exports[effectfulName] === "function";
    if (hasEffectful) {
      return runEffectfulManaged<T>(entryName, args);
    }

    const id = `detached_${detachedRunCounter++}`;
    const outcome = runPure<T>(entryName, args)
      .then<RunOutcome<T>>((value) => ({ kind: "value", value }))
      .catch<RunOutcome<T>>((error) => ({ kind: "failed", error: toError(error) }));
    return {
      id,
      outcome,
      cancel: () => false,
    };
  };

  const runEffectful = async <T = unknown>(
    entryName: string,
    args: unknown[] = []
  ): Promise<T> => {
    return unwrapRunOutcome(runEffectfulManaged<T>(entryName, args).outcome);
  };

  const run = async <T = unknown>(
    entryName: string,
    args: unknown[] = []
  ): Promise<T> => {
    return unwrapRunOutcome(runManaged<T>(entryName, args).outcome);
  };

  const host: VoydHost = {
    table,
    instance,
    registerHandler,
    registerHandlersByLabelSuffix: (handlersByLabelSuffix) =>
      registerHandlersByLabelSuffix({
        host: { table, registerHandler },
        handlersByLabelSuffix,
      }),
    registerDefaultAdapters: (options = {}) =>
      registerDefaultHostAdapters({
        host: { table, registerHandler },
        options: {
          ...options,
          effectBufferSize: bufferSize,
        },
      }),
    initEffects,
    runPure,
    runEffectfulManaged,
    runManaged,
    runEffectful,
    run,
  };

  if (defaultAdapters !== false) {
    await host.registerDefaultAdapters(
      typeof defaultAdapters === "object" ? defaultAdapters : {}
    );
  }

  return host;
};
