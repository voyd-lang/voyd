import type {
  EffectHandler,
  HostProtocolTable,
  RunOutcome,
  SignatureHash,
  VoydRunHandle,
} from "./protocol/types.js";
import { decode, encode } from "@msgpack/msgpack";
import {
  buildEffectOpKey,
  buildParsedEffectOpMap,
  resolveParsedEffectOp,
  type EffectOpRequest,
} from "./effect-op.js";
import {
  EFFECT_TABLE_EXPORT,
  parseEffectTable,
  toHostProtocolTable,
} from "./protocol/table.js";
import {
  LINEAR_MEMORY_EXPORT,
  MIN_EFFECT_BUFFER_SIZE,
} from "./runtime/constants.js";
import { ensureMemoryCapacity } from "./runtime/memory.js";
import type { ParsedEffectOp, ParsedEffectTable } from "./protocol/table.js";
import { registerHandlersByLabelSuffix } from "./handlers.js";
import { parseExportAbi } from "./protocol/export-abi.js";
import {
  createRuntimeScheduler,
  type RuntimeSchedulerOptions,
  type RuntimeStepResult,
} from "./runtime/scheduler.js";
import { continueEffectLoopStep } from "./runtime/dispatch.js";
import {
  registerDefaultHostAdapters,
  type DefaultAdapterOptions,
  type DefaultAdapterRegistration,
} from "./adapters/default.js";
import { detectHostRuntime, scheduleTaskForRuntime } from "./runtime/environment.js";
import {
  createVoydTrapDiagnostics,
  type VoydTrapAnnotation,
  type VoydRuntimePanicContext,
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
const TASK_RUNTIME_IMPORT_MODULE = "voyd.task";
const TASK_RUNTIME_EFFECT_ID = "voyd.std.task.runtime";
const TASK_RUNTIME_WAIT_OP_ID = 0;
const TASK_RUNTIME_YIELD_OP_ID = 1;
const TASK_RUNTIME_FAILURE_MESSAGE_OP_ID = 2;
const RESUME_EFFECTFUL_RAW_EXPORT = "resume_effectful_raw";
const END_REQUEST_RAW_EXPORT = "end_request_raw";
const HANDLE_OUTCOME_EXPORT = "handle_outcome";
const OUTCOME_TAG_EXPORT = "__voyd_outcome_tag";
let detachedRunCounter = 1;

type ActiveTaskImportContext = {
  spawnTask: (params: {
    detached: boolean;
    starterExportName: string;
    work: unknown;
  }) => number;
  cancelTask: (id: number) => boolean;
  takeTaskValue: (id: number) => unknown;
};

type ActiveTaskContext = ActiveTaskImportContext & {
  activeTaskId: number;
};

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const taskFailureMessage = (error: Error): string => {
  const panic = (error as Error & {
    voyd?: {
      panic?: { status: "available"; message: string } | { status: string };
    };
  }).voyd?.panic;
  if (panic && panic.status === "available" && "message" in panic) {
    return panic.message;
  }
  return error.message;
};

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

const PANIC_TRAP_PTR_GLOBAL = "__voyd_panic_ptr";
const PANIC_TRAP_LEN_GLOBAL = "__voyd_panic_len";

const defaultImports = (): WebAssembly.Imports => ({
  env: {},
});

const buildTaskRuntimeImportModule = ({
  importDescriptors,
  getContext,
}: {
  importDescriptors: WebAssembly.ModuleImportDescriptor[];
  getContext: () => ActiveTaskImportContext | undefined;
}): WebAssembly.Imports => {
  const taskRuntimeImports: Record<string, CallableFunction> = {};

  importDescriptors
    .filter(
      (descriptor) =>
        descriptor.module === TASK_RUNTIME_IMPORT_MODULE &&
        descriptor.kind === "function",
    )
    .forEach((descriptor) => {
      const currentContext = (): ActiveTaskImportContext => {
        const active = getContext();
        if (!active) {
          throw new Error(
            `task runtime import ${descriptor.name} called outside an active task`,
          );
        }
        return active;
      };

      if (descriptor.name.startsWith("spawn_attached__")) {
        const starterExportName = descriptor.name.slice("spawn_attached__".length);
        taskRuntimeImports[descriptor.name] = ((work: unknown): number =>
          currentContext().spawnTask({
            detached: false,
            starterExportName,
            work,
          })) as CallableFunction;
        return;
      }

      if (descriptor.name.startsWith("spawn_detached__")) {
        const starterExportName = descriptor.name.slice("spawn_detached__".length);
        taskRuntimeImports[descriptor.name] = ((work: unknown): number =>
          currentContext().spawnTask({
            detached: true,
            starterExportName,
            work,
          })) as CallableFunction;
        return;
      }

      if (descriptor.name === "cancel") {
        taskRuntimeImports.cancel = ((id: number): number =>
          currentContext().cancelTask(id) ? 1 : 0) as CallableFunction;
        return;
      }

      if (descriptor.name === "take_value") {
        taskRuntimeImports.take_value = ((id: number): unknown =>
          currentContext().takeTaskValue(id)) as CallableFunction;
      }
    });

  return Object.keys(taskRuntimeImports).length === 0
    ? {}
    : {
        [TASK_RUNTIME_IMPORT_MODULE]: taskRuntimeImports,
      };
};

const isImportModuleRecord = (
  value: unknown
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const mergeDefaultImports = (
  defaults: WebAssembly.Imports,
  imports?: WebAssembly.Imports
): WebAssembly.Imports => {
  const defaultModules = defaults as Record<string, unknown>;
  if (!imports) {
    return defaultModules as WebAssembly.Imports;
  }
  const merged = {
    ...defaultModules,
    ...(imports as Record<string, unknown>),
  } as Record<string, unknown>;

  const importRecord = imports as Record<string, unknown>;
  ["env"].forEach((moduleName) => {
    const defaultModule = defaultModules[moduleName];
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

const hasExportedFunction = ({
  instance,
  name,
}: {
  instance: WebAssembly.Instance;
  name: string;
}): boolean => typeof instance.exports[name] === "function";

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

const panicContextFromTrapGlobals = ({
  instance,
  ptr,
  len,
}: {
  instance?: WebAssembly.Instance;
  ptr: number;
  len: number;
}): VoydRuntimePanicContext => {
  if (len < 0) {
    return {
      status: "unavailable",
      byteLength: len,
      reason: "invalid-length",
    };
  }
  if (ptr < 0) {
    return {
      status: "unavailable",
      byteLength: len,
      reason: "message-storage-unavailable",
    };
  }
  if (!instance) {
    return {
      status: "unavailable",
      byteLength: len,
      reason: "instance-unavailable",
    };
  }
  const exported = instance.exports[LINEAR_MEMORY_EXPORT];
  if (!(exported instanceof WebAssembly.Memory)) {
    return {
      status: "unavailable",
      byteLength: len,
      reason: "memory-export-missing",
    };
  }
  if (len === 0) {
    return {
      status: "available",
      message: "",
      byteLength: 0,
    };
  }
  if (ptr + len > exported.buffer.byteLength) {
    return {
      status: "unavailable",
      byteLength: len,
      reason: "invalid-bounds",
    };
  }

  try {
    const bytes = new Uint8Array(exported.buffer, ptr, len);
    return {
      status: "available",
      message: new TextDecoder().decode(bytes),
      byteLength: len,
    };
  } catch {
    return {
      status: "unavailable",
      byteLength: len,
      reason: "decode-failed",
    };
  }
};

const requireMutableI32Global = ({
  instance,
  name,
}: {
  instance: WebAssembly.Instance;
  name: string;
}): WebAssembly.Global | undefined => {
  const exported = instance.exports[name];
  return exported instanceof WebAssembly.Global ? exported : undefined;
};

const consumePanicContext = ({
  instance,
}: {
  instance?: WebAssembly.Instance;
}): VoydRuntimePanicContext | undefined => {
  if (!instance) {
    return undefined;
  }
  const ptrGlobal = requireMutableI32Global({
    instance,
    name: PANIC_TRAP_PTR_GLOBAL,
  });
  const lenGlobal = requireMutableI32Global({
    instance,
    name: PANIC_TRAP_LEN_GLOBAL,
  });
  if (!ptrGlobal || !lenGlobal) {
    return undefined;
  }

  const ptr = ptrGlobal.value as number;
  const len = lenGlobal.value as number;
  const context =
    ptr === -1 && len === 0
      ? undefined
      : panicContextFromTrapGlobals({
          instance,
          ptr,
          len,
        });

  ptrGlobal.value = -1;
  lenGlobal.value = 0;
  return context;
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
  let instanceRef: WebAssembly.Instance | undefined;
  let activeTaskImportContext: ActiveTaskImportContext | undefined;
  const annotateTrap = (
    error: unknown,
    opts?: VoydTrapAnnotation
  ): Error => {
    const panic = consumePanicContext({ instance: instanceRef });
    return trapDiagnostics.annotateTrap(error, {
      ...opts,
      ...(panic ? { panic } : {}),
    });
  };
  const parsedTable = parseEffectTable(module, EFFECT_TABLE_EXPORT);
  const table = toHostProtocolTable(parsedTable);
  const exportAbi = parseExportAbi(module);
  const exportAbiByName = new Map(
    exportAbi.exports.map((entry) => [entry.name, entry] as const)
  );
  const taskRuntimeImports = buildTaskRuntimeImportModule({
    importDescriptors: WebAssembly.Module.imports(module),
    getContext: () => activeTaskImportContext,
  });
  instanceRef = new WebAssembly.Instance(
    module,
    mergeDefaultImports(
      {
        ...defaultImports(),
        ...(taskRuntimeImports as Record<string, unknown>),
      } as WebAssembly.Imports,
      imports
    )
  );
  const instance = instanceRef;

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

    const rawEntryName = `${effectfulExportNameFor(entryName)}_raw`;
    const hasRawTaskRuntime =
      hasExportedFunction({ instance, name: rawEntryName }) &&
      hasExportedFunction({ instance, name: OUTCOME_TAG_EXPORT }) &&
      hasExportedFunction({ instance, name: RESUME_EFFECTFUL_RAW_EXPORT }) &&
      hasExportedFunction({ instance, name: END_REQUEST_RAW_EXPORT });

    if (!hasRawTaskRuntime) {
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
      const id = `detached_${detachedRunCounter++}`;
      const outcome = (async (): Promise<RunOutcome<T>> => {
        try {
          let result: unknown;
          try {
            result = entry(bufferPtr, bufferSize);
          } catch (error) {
            throw annotateTrap(error, {
              transition: {
                point: "run_effectful_entry",
                direction: "host->vm",
              },
              fallbackFunctionName: effectfulExportNameFor(entryName),
            });
          }

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const stepResult = await continueEffectLoopStep<T>({
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
              annotateTrap,
              fallbackFunctionName: effectfulExportNameFor(entryName),
            });
            if (stepResult.kind === "value") {
              return { kind: "value", value: stepResult.value };
            }
            if (stepResult.kind === "aborted") {
              return {
                kind: "failed",
                error: new Error("effect loop step aborted outside scheduler context"),
              };
            }
            result = stepResult.result;
          }
        } catch (error) {
          return { kind: "failed", error: toError(error) };
        }
      })();

      void outcome.finally(() => {
        releaseEffectRunBufferPtr(bufferPtr);
      });

      return {
        id,
        outcome,
        cancel: () => false,
      };
    }

    const rawEntry = requireExportedFunction({
      instance,
      name: rawEntryName,
    });
    const effectCont = requireExportedFunction({
      instance,
      name: "effect_cont",
    });
    const effectLen = requireExportedFunction({
      instance,
      name: "effect_len",
    });
    const handleOutcome = requireExportedFunction({
      instance,
      name: HANDLE_OUTCOME_EXPORT,
    });
    const outcomeTag = requireExportedFunction({
      instance,
      name: OUTCOME_TAG_EXPORT,
    });
    const resumeEffectfulRaw = requireExportedFunction({
      instance,
      name: RESUME_EFFECTFUL_RAW_EXPORT,
    });
    const endRequestRaw = requireExportedFunction({
      instance,
      name: END_REQUEST_RAW_EXPORT,
    });

    type TaskCompletion =
      | { kind: "value"; rawOutcome: unknown }
      | { kind: "failed"; error: Error; message: string }
      | { kind: "cancelled"; reason?: unknown };

    type TaskTerminal = TaskCompletion & {
      observed: boolean;
      reportedUnhandled?: boolean;
    };
    type FailedTaskTerminal = Extract<TaskTerminal, { kind: "failed" }>;

    type TaskRecord = {
      id: number;
      ownerId: number | null;
      detached: boolean;
      state: "ready" | "waiting" | "completing" | "terminal";
      starter?: () => unknown;
      pendingRawOutcome?: unknown;
      pendingResume?: { request: unknown; value: unknown };
      pendingCompletion?: TaskCompletion;
      terminal?: TaskTerminal;
      waiters: Array<{ taskId: number; request: unknown }>;
      children: Set<number>;
    };

    type RunState = ActiveTaskImportContext & {
      nextTaskId: number;
      rootTaskId: number;
      tasks: Map<number, TaskRecord>;
      readyQueue: number[];
      wakeResolver?: (result: RuntimeStepResult<RunState>) => void;
      finalOutcome?: RunOutcome<T>;
    };

    const encodeToBuffer = (value: unknown): number => {
      const encoded = encode(value, MSGPACK_OPTS) as Uint8Array;
      if (encoded.length > bufferSize) {
        throw new Error("resume payload exceeds buffer size");
      }
      new Uint8Array(msgpackMemory.buffer, bufferPtr, encoded.length).set(encoded);
      return encoded.length;
    };

    const decodeFromBuffer = (length: number): unknown =>
      decode(
        new Uint8Array(msgpackMemory.buffer, bufferPtr, length),
        MSGPACK_OPTS
      );

    const runWithActiveTask = <R>(
      context: ActiveTaskContext,
      fn: () => R
    ): R => {
      const previous = activeTaskImportContext;
      activeTaskImportContext = context;
      try {
        return fn();
      } finally {
        activeTaskImportContext = previous;
      }
    };

    const waitStatusFor = (terminal: TaskTerminal): number =>
      terminal.kind === "value" ? 0 : terminal.kind === "failed" ? 1 : 2;

    const toActiveTaskContext = ({
      state,
      activeTaskId,
    }: {
      state: RunState;
      activeTaskId: number;
    }): ActiveTaskContext => ({
      spawnTask: state.spawnTask,
      cancelTask: state.cancelTask,
      takeTaskValue: state.takeTaskValue,
      activeTaskId,
    });

    const resumeTask = ({
      state,
      taskId,
      request,
      value,
    }: {
      state: RunState;
      taskId: number;
      request: unknown;
      value: unknown;
    }): unknown =>
      runWithActiveTask(
        toActiveTaskContext({
          state,
          activeTaskId: taskId,
        }),
        () => {
          const length = encodeToBuffer(value);
          return resumeEffectfulRaw(request, bufferPtr, length);
        }
      );

    const currentActiveTaskId = (): number | null => {
      const active = activeTaskImportContext as ActiveTaskContext | undefined;
      return active?.activeTaskId ?? null;
    };

    const getFailedTerminal = (
      terminal?: TaskTerminal
    ): FailedTaskTerminal | undefined =>
      terminal?.kind === "failed" ? terminal : undefined;

    const findUnobservedFailedChild = ({
      state,
      owner,
    }: {
      state: RunState;
      owner: TaskRecord;
    }): FailedTaskTerminal | undefined =>
      Array.from(owner.children)
        .map((childId) => state.tasks.get(childId)?.terminal)
        .find((terminal): terminal is FailedTaskTerminal => {
          const failedTerminal = getFailedTerminal(terminal);
          return !!failedTerminal && failedTerminal.observed !== true;
        });

    const effectContextFor = ({
      opEntry,
      continuationBoundary,
    }: {
      opEntry: ParsedEffectOp;
      continuationBoundary?: "resume" | "tail" | "end";
    }) => ({
      effectId: opEntry.effectId,
      opId: opEntry.opId,
      opName: opEntry.label.slice(opEntry.label.lastIndexOf(".") + 1),
      label: opEntry.label,
      resumeKind: opEntry.resumeKind === 1 ? ("tail" as const) : ("resume" as const),
      ...(continuationBoundary ? { continuationBoundary } : {}),
    });

    const invalidHandlerResultMessage = (opEntry: ParsedEffectOp): string =>
      `handler for ${opEntry.label} must return a continuation call`;

    const invalidContinuationMessage = ({
      opEntry,
      actualKind,
    }: {
      opEntry: ParsedEffectOp;
      actualKind: "resume" | "tail" | "end";
    }): string =>
      opEntry.resumeKind === 1
        ? `handler for ${opEntry.label} must return tail(...)`
        : actualKind === "tail"
          ? `handler for ${opEntry.label} cannot return tail(...)`
          : `invalid continuation kind for ${opEntry.label}`;

    const reportUnhandledDetachedFailure = ({
      error,
      message,
      taskId,
    }: {
      error: Error;
      message: string;
      taskId: number;
    }): void => {
      const reportedError =
        error.message === message ? error : new Error(message, { cause: error });
      try {
        scheduler?.onUnhandledTaskFailed?.(reportedError, {
          runId: run.id,
          taskId,
        });
      } catch {
        // Swallow observer failures to keep runtime semantics deterministic.
      }
      if (!scheduler?.onUnhandledTaskFailed) {
        console.error(
          `[voyd] unhandled detached task failure in run ${run.id}: ${message}`
        );
      }
    };

    let liveState: RunState | undefined;

    const run = runtimeScheduler.startRun<T>({
      start: () => {
        const rootTaskId = 1;
        const state: RunState = {
          nextTaskId: 2,
          rootTaskId,
          tasks: new Map<number, TaskRecord>(),
          readyQueue: [rootTaskId],
          spawnTask: ({
            detached,
            starterExportName,
            work,
          }: {
            detached: boolean;
            starterExportName: string;
            work: unknown;
          }): number => {
            const ownerId = currentActiveTaskId();
            const taskId = state.nextTaskId++;
            const starter = requireExportedFunction({
              instance,
              name: starterExportName,
            });
            state.tasks.set(taskId, {
              id: taskId,
              ownerId: detached ? null : ownerId,
              detached,
              state: "ready",
              starter: () =>
                runWithActiveTask(
                  toActiveTaskContext({
                    state,
                    activeTaskId: taskId,
                  }),
                  () => {
                    try {
                      return starter(work);
                    } catch (error) {
                      throw annotateTrap(error, {
                        transition: {
                          point: "effectful_entry",
                          direction: "host->vm",
                        },
                        fallbackFunctionName: starterExportName,
                      });
                    }
                  }
                ),
              waiters: [],
              children: new Set<number>(),
            });
            if (!detached && ownerId !== null) {
              state.tasks.get(ownerId)?.children.add(taskId);
            }
            state.readyQueue.push(taskId);
            state.wakeResolver?.({ kind: "next", result: state });
            state.wakeResolver = undefined;
            return taskId;
          },
          cancelTask: (id: number): boolean => {
            const cancelTask = (taskId: number): boolean => {
              const task = state.tasks.get(taskId);
              if (!task || task.state === "terminal") {
                return false;
              }
              task.children.forEach((childId) => cancelTask(childId));
              task.state = "terminal";
              task.pendingRawOutcome = undefined;
              task.pendingResume = undefined;
              task.pendingCompletion = undefined;
              task.terminal = {
                kind: "cancelled",
                observed: false,
              };
              task.waiters.forEach(({ taskId: waiterTaskId, request }) => {
                try {
                  const resumed = resumeTask({
                    state,
                    taskId: waiterTaskId,
                    request,
                    value: 2,
                  });
                  const waiter = state.tasks.get(waiterTaskId);
                  if (waiter && waiter.state !== "terminal") {
                    waiter.pendingRawOutcome = resumed;
                    waiter.state = "ready";
                    state.readyQueue.push(waiterTaskId);
                  }
                } catch {
                  // Ignore late waiter wakeups after cancellation.
                }
              });
              task.waiters = [];
              return true;
            };
            const changed = cancelTask(id);
            if (changed) {
              state.wakeResolver?.({ kind: "next", result: state });
              state.wakeResolver = undefined;
            }
            return changed;
          },
          takeTaskValue: (id: number): unknown => {
            const task = state.tasks.get(id);
            if (!task?.terminal || task.terminal.kind !== "value") {
              throw new Error(`task ${id} is not complete with a value`);
            }
            task.terminal.observed = true;
            return task.terminal.rawOutcome;
          },
        };

        state.tasks.set(rootTaskId, {
          id: rootTaskId,
          ownerId: null,
          detached: false,
          state: "ready",
          starter: () =>
            runWithActiveTask(
              toActiveTaskContext({
                state,
                activeTaskId: rootTaskId,
              }),
              () => {
                try {
                  return rawEntry(bufferPtr, bufferSize);
                } catch (error) {
                  throw annotateTrap(error, {
                    transition: {
                      point: "effectful_entry",
                      direction: "host->vm",
                    },
                    fallbackFunctionName: entryName,
                  });
                }
              }
            ),
          waiters: [],
          children: new Set<number>(),
        });

        liveState = state;
        return state;
      },
      step: async (rawState, _context) => {
        const state = rawState as RunState;
        liveState = state;
        const wakeRun = (): RuntimeStepResult<T> | Promise<RuntimeStepResult<T>> => {
            if (state.finalOutcome) {
            return state.finalOutcome.kind === "value"
              ? { kind: "value", value: state.finalOutcome.value }
              : state.finalOutcome.kind === "failed"
                ? Promise.reject(state.finalOutcome.error)
                : Promise.resolve({ kind: "aborted" });
          }
            const nextTaskId = state.readyQueue.shift();
            if (typeof nextTaskId !== "number") {
              return new Promise<RuntimeStepResult<T>>((resolve) => {
                state.wakeResolver = (result) =>
                  resolve(result as RuntimeStepResult<T>);
            });
          }

          const task = state.tasks.get(nextTaskId);
          if (!task || task.state === "terminal" || task.state === "completing") {
            return { kind: "next", result: state };
          }

          const finalizeIfDone = (): void => {
            const rootTask = state.tasks.get(state.rootTaskId);
            const liveTaskCount = Array.from(state.tasks.values()).filter(
              (entry) => entry.state !== "terminal"
            ).length;
            if (!rootTask?.terminal || liveTaskCount > 0) {
              return;
            }
            if (rootTask.terminal.kind === "value") {
              const effectResult = handleOutcome(
                rootTask.terminal.rawOutcome,
                bufferPtr,
                bufferSize
              );
              const payloadLength = effectLen(effectResult) as number;
              state.finalOutcome = {
                kind: "value",
                value: decodeFromBuffer(payloadLength) as T,
              };
              return;
            }
            if (rootTask.terminal.kind === "failed") {
              state.finalOutcome = {
                kind: "failed",
                error: rootTask.terminal.error,
              };
              return;
            }
            state.finalOutcome = {
              kind: "cancelled",
              reason: rootTask.terminal.reason,
            };
          };

          const maybeCompleteOwner = (taskId: number): void => {
            const owner = state.tasks.get(taskId);
            if (!owner || owner.state !== "completing" || !owner.pendingCompletion) {
              return;
            }
            const liveChildren = Array.from(owner.children)
              .map((childId) => state.tasks.get(childId))
              .filter((entry) => entry && entry.state !== "terminal");
            if (liveChildren.length > 0) {
              return;
            }
            const unobservedFailure = findUnobservedFailedChild({
              state,
              owner,
            });
            const pending = owner.pendingCompletion;
            owner.pendingCompletion = undefined;
            owner.pendingResume = undefined;
            if (pending.kind === "value" && unobservedFailure) {
              owner.state = "terminal";
              owner.terminal = {
                kind: "failed",
                error: new Error(
                  `unobserved child task failure: ${unobservedFailure.message}`
                ),
                message: unobservedFailure.message,
                observed: false,
              };
            } else {
              owner.state = "terminal";
              owner.terminal = {
                ...pending,
                observed: false,
              };
            }
            owner.waiters.forEach(({ taskId: waiterTaskId, request }) => {
              try {
                owner.terminal!.observed = true;
                const resumed = resumeTask({
                  state,
                  taskId: waiterTaskId,
                  request,
                  value: waitStatusFor(owner.terminal!),
                });
                const waiter = state.tasks.get(waiterTaskId);
                if (waiter && waiter.state !== "terminal") {
                  waiter.pendingRawOutcome = resumed;
                  waiter.state = "ready";
                  state.readyQueue.push(waiterTaskId);
                }
              } catch (error) {
                const normalized = annotateTrap(error, {
                  transition: {
                    point: "resume_effectful",
                    direction: "host->vm",
                  },
                });
                completeTask(waiterTaskId, {
                  kind: "failed",
                  error: normalized,
                  message: taskFailureMessage(normalized),
                });
              }
            });
            owner.waiters = [];
            const ownerFailure = getFailedTerminal(owner.terminal);
            if (owner.detached && ownerFailure && !ownerFailure.observed) {
              reportUnhandledDetachedFailure({
                error: ownerFailure.error,
                message: ownerFailure.message,
                taskId: owner.id,
              });
              ownerFailure.reportedUnhandled = true;
            }
            if (owner.ownerId !== null) {
              maybeCompleteOwner(owner.ownerId);
            }
            state.wakeResolver?.({ kind: "next", result: state });
            state.wakeResolver = undefined;
            finalizeIfDone();
          };

          const completeTask = (taskId: number, completion: TaskCompletion): void => {
            const current = state.tasks.get(taskId);
            if (!current || current.state === "terminal") {
              return;
            }
            const liveChildren = Array.from(current.children)
              .map((childId) => state.tasks.get(childId))
              .filter((entry) => entry && entry.state !== "terminal");
            if (completion.kind !== "value") {
              current.children.forEach((childId) => {
                state.cancelTask(childId);
              });
            }
            if (liveChildren.length > 0) {
              current.state = "completing";
              current.pendingCompletion = completion;
              return;
            }
            const unobservedFailure =
              completion.kind === "value"
                ? findUnobservedFailedChild({
                    state,
                    owner: current,
                  })
                : undefined;
            current.state = "terminal";
            current.pendingCompletion = undefined;
            current.pendingResume = undefined;
            current.terminal =
              completion.kind === "value" && unobservedFailure
                ? {
                    kind: "failed",
                    error: new Error(
                      `unobserved child task failure: ${unobservedFailure.message}`
                    ),
                    message: unobservedFailure.message,
                    observed: false,
                  }
                : {
                    ...completion,
                    observed: false,
                  };
            current.waiters.forEach(({ taskId: waiterTaskId, request }) => {
              try {
                current.terminal!.observed = true;
                const resumed = resumeTask({
                  state,
                  taskId: waiterTaskId,
                  request,
                  value: waitStatusFor(current.terminal!),
                });
                const waiter = state.tasks.get(waiterTaskId);
                if (waiter && waiter.state !== "terminal") {
                  waiter.pendingRawOutcome = resumed;
                  waiter.state = "ready";
                  state.readyQueue.push(waiterTaskId);
                }
              } catch (error) {
                const normalized = annotateTrap(error, {
                  transition: {
                    point: "resume_effectful",
                    direction: "host->vm",
                  },
                });
                completeTask(waiterTaskId, {
                  kind: "failed",
                  error: normalized,
                  message: taskFailureMessage(normalized),
                });
              }
            });
            current.waiters = [];
            const currentFailure = getFailedTerminal(current.terminal);
            if (current.detached && currentFailure && !currentFailure.observed) {
              reportUnhandledDetachedFailure({
                error: currentFailure.error,
                message: currentFailure.message,
                taskId: current.id,
              });
              currentFailure.reportedUnhandled = true;
            }
            if (current.ownerId !== null) {
              maybeCompleteOwner(current.ownerId);
            }
            state.wakeResolver?.({ kind: "next", result: state });
            state.wakeResolver = undefined;
            finalizeIfDone();
          };

          const applyContinuation = ({
            taskId,
            request,
            opEntry,
            handlerResult,
          }: {
            taskId: number;
            request: unknown;
            opEntry: ParsedEffectOp;
            handlerResult: {
              kind: "resume" | "tail" | "end";
              value: unknown;
            };
          }): void => {
            if (
              (opEntry.resumeKind === 1 && handlerResult.kind !== "tail") ||
              (opEntry.resumeKind === 0 && handlerResult.kind === "tail")
            ) {
              const message = invalidContinuationMessage({
                opEntry,
                actualKind: handlerResult.kind,
              });
              completeTask(taskId, {
                kind: "failed",
                error: new Error(message),
                message,
              });
              return;
            }
            const current = state.tasks.get(taskId);
            if (!current || current.state === "terminal") {
              return;
            }
            try {
              const resumed = runWithActiveTask(
                toActiveTaskContext({
                  state,
                  activeTaskId: taskId,
                }),
                () => {
                  const length = encodeToBuffer(handlerResult.value);
                  return handlerResult.kind === "end"
                    ? endRequestRaw(request, bufferPtr, length)
                    : resumeEffectfulRaw(request, bufferPtr, length);
                }
              );
              current.pendingRawOutcome = resumed;
              current.state = "ready";
              state.readyQueue.push(taskId);
              state.wakeResolver?.({ kind: "next", result: state });
              state.wakeResolver = undefined;
            } catch (error) {
              const normalized = annotateTrap(error, {
                effect: effectContextFor({
                  opEntry,
                  continuationBoundary: handlerResult.kind,
                }),
                transition: {
                  point: "resume_effectful",
                  direction: "host->vm",
                },
              });
              completeTask(taskId, {
                kind: "failed",
                error: normalized,
                message: taskFailureMessage(normalized),
              });
            }
          };

            try {
              const rawOutcome =
                task.pendingRawOutcome ??
                (task.pendingResume
                  ? (() => {
                      const pending = task.pendingResume;
                      task.pendingResume = undefined;
                      return resumeTask({
                        state,
                        taskId: nextTaskId,
                        request: pending.request,
                        value: pending.value,
                      });
                    })()
                  : task.starter?.());
            task.pendingRawOutcome = undefined;
            task.starter = undefined;
            const tag = outcomeTag(rawOutcome) as number;
            if (tag === 0) {
              completeTask(nextTaskId, {
                kind: "value",
                rawOutcome,
              });
              return { kind: "next", result: state };
            }

            const effectResult = handleOutcome(rawOutcome, bufferPtr, bufferSize);
            const payloadLength = effectLen(effectResult) as number;
            const request = effectCont(effectResult);
            const decodedEffect = decodeFromBuffer(payloadLength) as EffectOpRequest;
            const opEntry = resolveParsedEffectOp({
              table: parsedTable,
              request: decodedEffect,
            });

            if (opEntry.effectId === TASK_RUNTIME_EFFECT_ID) {
              if (opEntry.opId === TASK_RUNTIME_WAIT_OP_ID) {
                const targetId = Number(decodedEffect.args?.[0]);
                const target = state.tasks.get(targetId);
                if (!target) {
                  completeTask(nextTaskId, {
                    kind: "failed",
                    error: new Error(`unknown task ${targetId}`),
                    message: `unknown task ${targetId}`,
                  });
                  return { kind: "next", result: state };
                }
                if (target.terminal) {
                  target.terminal.observed = true;
                  applyContinuation({
                    taskId: nextTaskId,
                    request,
                    opEntry,
                    handlerResult: {
                      kind: "resume",
                      value: waitStatusFor(target.terminal),
                    },
                  });
                  return { kind: "next", result: state };
                }
                task.state = "waiting";
                target.waiters.push({ taskId: nextTaskId, request });
                return { kind: "next", result: state };
              }

              if (opEntry.opId === TASK_RUNTIME_YIELD_OP_ID) {
                task.pendingResume = {
                  request,
                  value: undefined,
                };
                task.state = "ready";
                state.readyQueue.push(nextTaskId);
                return { kind: "next", result: state };
              }

              if (opEntry.opId === TASK_RUNTIME_FAILURE_MESSAGE_OP_ID) {
                const targetId = Number(decodedEffect.args?.[0]);
                const target = state.tasks.get(targetId);
                if (!target?.terminal || target.terminal.kind !== "failed") {
                  completeTask(nextTaskId, {
                    kind: "failed",
                    error: new Error(`task ${targetId} has no failure message`),
                    message: `task ${targetId} has no failure message`,
                  });
                  return { kind: "next", result: state };
                }
                target.terminal.observed = true;
                applyContinuation({
                  taskId: nextTaskId,
                  request,
                  opEntry,
                  handlerResult: {
                    kind: "tail",
                    value: target.terminal.message,
                  },
                });
                return { kind: "next", result: state };
              }
            }

            const handler = handlersByOpIndex[opEntry.opIndex];
            if (!handler) {
              completeTask(nextTaskId, {
                kind: "failed",
                error: new Error(`Unhandled effect ${opEntry.label}`),
                message: `Unhandled effect ${opEntry.label}`,
              });
              return { kind: "next", result: state };
            }

            const toContinuationCall = (kind: "resume" | "tail" | "end", value: unknown) => ({
              kind,
              value,
            });
            const handlerResult = handler(
              {
                resume: (...args: unknown[]) =>
                  toContinuationCall("resume", args.length <= 1 ? args[0] : args),
                tail: (...args: unknown[]) =>
                  toContinuationCall("tail", args.length <= 1 ? args[0] : args),
                end: (value: unknown) => toContinuationCall("end", value),
              },
              ...(decodedEffect.args ?? [])
            );

            if (handlerResult instanceof Promise) {
              task.state = "waiting";
              void handlerResult.then(
                (resolved) => {
                  if (
                    !resolved ||
                    typeof resolved !== "object" ||
                    !("kind" in resolved)
                  ) {
                    const message = invalidHandlerResultMessage(opEntry);
                    completeTask(nextTaskId, {
                      kind: "failed",
                      error: new Error(message),
                      message,
                    });
                    return;
                  }
                  applyContinuation({
                    taskId: nextTaskId,
                    request,
                    opEntry,
                    handlerResult: resolved as {
                      kind: "resume" | "tail" | "end";
                      value: unknown;
                    },
                  });
                },
                (error) => {
                  const normalized = toError(error);
                  completeTask(nextTaskId, {
                    kind: "failed",
                    error: normalized,
                    message: taskFailureMessage(normalized),
                  });
                }
              );
              return { kind: "next", result: state };
            }

            if (
              !handlerResult ||
              typeof handlerResult !== "object" ||
              !("kind" in handlerResult)
            ) {
              const message = invalidHandlerResultMessage(opEntry);
              completeTask(nextTaskId, {
                kind: "failed",
                error: new Error(message),
                message,
              });
              return { kind: "next", result: state };
            }
            applyContinuation({
              taskId: nextTaskId,
              request,
              opEntry,
              handlerResult: handlerResult as {
                kind: "resume" | "tail" | "end";
                value: unknown;
              },
            });
            return { kind: "next", result: state };
          } catch (error) {
            const normalized = toError(error);
            completeTask(nextTaskId, {
              kind: "failed",
              error: normalized,
              message: taskFailureMessage(normalized),
            });
            return { kind: "next", result: state };
          }
        };

        return wakeRun();
      },
    });
    const managedRun: VoydRunHandle<T> = {
      ...run,
      cancel: (reason?: unknown): boolean => {
        const cancelled = run.cancel(reason);
        if (cancelled) {
          const state = liveState;
          if (state) {
            Array.from(state.tasks.keys()).forEach((taskId) => {
              state.cancelTask(taskId);
            });
          }
        }
        return cancelled;
      },
    };
    void managedRun.outcome.finally(() => {
      liveState = undefined;
      releaseEffectRunBufferPtr(bufferPtr);
    });
    return managedRun;
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
          effectBufferSize: options.effectBufferSize ?? bufferSize,
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
