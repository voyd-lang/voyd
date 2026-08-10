import type {
  EffectHandler,
  EffectResourceCleanup,
  HostProtocolTable,
  RunOutcome,
  SignatureHash,
  VoydRunHandle,
} from "./protocol/types.js";
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
  decodeBoundaryResult,
  decodeDirectBoundaryResult,
  encodeBoundaryArgs,
  encodeDirectBoundaryArgs,
} from "./boundary-values.js";
import type { ExportAbiEntry } from "./protocol/export-abi.js";
import {
  resolveHostTransport,
  type HostTransportAdapter,
} from "./protocol/host-transport.js";
import {
  createRuntimeScheduler,
  type RuntimeSchedulerOptions,
  type RuntimeStepResult,
} from "./runtime/scheduler.js";
import {
  continueEffectLoopStep,
  decodeHostCompletion,
  type HostCompletionIdentity,
} from "./runtime/dispatch.js";
import {
  registerDefaultHostAdapters,
  type DefaultAdapterOptions,
  type DefaultAdapterRegistration,
} from "./adapters/default.js";
import {
  detectHostRuntime,
  scheduleTaskForRuntime,
} from "./runtime/environment.js";
import {
  createVoydTrapDiagnostics,
  type VoydTrapAnnotation,
  type VoydRuntimePanicContext,
} from "./runtime/trap-diagnostics.js";
import {
  createRetainedCallbackScopeManager,
  createRetainedEventHandlerRegistry,
  type RetainedCallbackScopeManager,
  type RetainedCallbackScopeOwner,
  type RetainedEventHandlerRegistry,
  type WasmEventHandlerRef,
} from "./retained-callbacks.js";
import type { VoydPackageAdapter } from "@voyd-lang/package-adapter";
import {
  buildExternalImportModule,
  parseExternalRequirements,
  registerExternalAdapterHandlers,
} from "./protocol/external.js";

export type HostInitOptions = {
  wasm: Uint8Array | WebAssembly.Module;
  imports?: WebAssembly.Imports;
  bufferSize?: number;
  scheduler?: RuntimeSchedulerOptions;
  defaultAdapters?: boolean | DefaultAdapterOptions;
  retainedCallbacks?: RetainedEventHandlerRegistry;
  adapters?: readonly VoydPackageAdapter[];
  transportAdapters?: readonly HostTransportAdapter[];
};

export type VoydHost = {
  table: HostProtocolTable;
  instance: WebAssembly.Instance;
  registerHandler: (
    effectId: string,
    opId: number,
    signatureHash: SignatureHash,
    handler: EffectHandler,
  ) => void;
  registerHandlersByLabelSuffix: (
    handlersByLabelSuffix: Record<string, EffectHandler>,
  ) => number;
  registerDefaultAdapters: (
    options?: DefaultAdapterOptions,
  ) => Promise<DefaultAdapterRegistration>;
  initEffects: () => void;
  runPure: <T = unknown>(entryName: string, args?: unknown[]) => Promise<T>;
  runEffectfulManaged: <T = unknown>(
    entryName: string,
    args?: unknown[],
  ) => VoydRunHandle<T>;
  hasExport: (entryName: string) => boolean;
  runManaged: <T = unknown>(
    entryName: string,
    args?: unknown[],
  ) => VoydRunHandle<T>;
  runEffectful: <T = unknown>(
    entryName: string,
    args?: unknown[],
  ) => Promise<T>;
  run: <T = unknown>(entryName: string, args?: unknown[]) => Promise<T>;
  retainedCallbacks: RetainedEventHandlerRegistry;
};

const TASK_RUNTIME_IMPORT_MODULE = "voyd.task";
const CALLBACK_IMPORT_MODULE = "voyd.callback";
const BOUNDARY_CALLBACK_IMPORT_MODULE = "voyd.boundary.callback";
const RENDER_CALLBACK_IMPORT_MODULE = "voyd.render.callback";
const LEGACY_VX_CALLBACK_IMPORT_MODULE = "voyd.vx.callback";
const CALLBACK_SCOPE_IMPORT_MODULE = "voyd.callback.scope";
const TASK_RUNTIME_EFFECT_ID = "voyd.std.task.runtime";
const TASK_RUNTIME_WAIT_OP_ID = 0;
const TASK_RUNTIME_YIELD_OP_ID = 1;
const TASK_RUNTIME_FAILURE_MESSAGE_OP_ID = 2;
const RESUME_EFFECTFUL_RAW_EXPORT = "resume_effectful_raw";
const END_REQUEST_RAW_EXPORT = "end_request_raw";
const HANDLE_OUTCOME_EXPORT = "handle_outcome";
const OUTCOME_TAG_EXPORT = "__voyd_outcome_tag";
const TASK_OBSERVER_SYMBOL = Symbol.for("voyd.taskObserver");
let detachedRunCounter = 1;

type ActiveTaskImportContext = {
  spawnTask: (params: {
    detached: boolean;
    starterExportName: string;
    workArgs: readonly unknown[];
  }) => number;
  cancelTask: (id: number) => boolean;
  takeTaskValue: (id: number) => unknown;
};

type ActiveTaskContext = ActiveTaskImportContext & {
  activeTaskId: number;
  callbackScopeOwner: RetainedCallbackScopeOwner;
};

type RetainedEffectfulCallbackRunner = (params: {
  callbackExportName: string;
  handlerRef: unknown;
  payload: unknown;
}) => Promise<unknown>;

type RawEffectfulStarter = (params: {
  bufferPtr: number;
  bufferSize: number;
}) => unknown;

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const taskFailureMessage = (error: Error): string => {
  const panic = (
    error as Error & {
      voyd?: {
        panic?: { status: "available"; message: string } | { status: string };
      };
    }
  ).voyd?.panic;
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

const unwrapRunOutcome = async <T>(
  outcome: Promise<RunOutcome<T>>,
): Promise<T> => {
  const settled = await outcome;
  if (settled.kind === "value") return settled.value;
  if (settled.kind === "failed") throw settled.error;
  throw new CancelledRunError(settled.reason);
};

const attachTaskObserver = <T>(
  value: T,
  observeTask: VoydRunHandle["observeTask"] | undefined,
): T => {
  if (!observeTask || typeof value !== "object" || value === null) {
    return value;
  }
  Object.defineProperty(value, TASK_OBSERVER_SYMBOL, {
    configurable: true,
    enumerable: false,
    value: observeTask,
  });
  return value;
};

const PANIC_TRAP_PTR_GLOBAL = "__voyd_panic_ptr";
const PANIC_TRAP_LEN_GLOBAL = "__voyd_panic_len";

const defaultImports = (): WebAssembly.Imports => ({
  env: {},
});

const buildTaskRuntimeImportModule = ({
  importDescriptors,
  getContext,
  spawnDetachedOutsideContext,
}: {
  importDescriptors: WebAssembly.ModuleImportDescriptor[];
  getContext: () => ActiveTaskImportContext | undefined;
  spawnDetachedOutsideContext?: (params: {
    starterExportName: string;
    workArgs: readonly unknown[];
  }) => number;
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
        const starterExportName = descriptor.name.slice(
          "spawn_attached__".length,
        );
        taskRuntimeImports[descriptor.name] = ((
          ...workArgs: unknown[]
        ): number =>
          currentContext().spawnTask({
            detached: false,
            starterExportName,
            workArgs,
          })) as CallableFunction;
        return;
      }

      if (descriptor.name.startsWith("spawn_detached__")) {
        const starterExportName = descriptor.name.slice(
          "spawn_detached__".length,
        );
        taskRuntimeImports[descriptor.name] = ((
          ...workArgs: unknown[]
        ): number =>
          getContext()?.spawnTask({
            detached: true,
            starterExportName,
            workArgs,
          }) ??
          spawnDetachedOutsideContext?.({
            starterExportName,
            workArgs,
          }) ??
          currentContext().spawnTask({
            detached: true,
            starterExportName,
            workArgs,
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

const buildRetainedCallbackImportModules = ({
  importDescriptors,
  getInstance,
  registry,
  bufferSize,
  annotateTrap,
  runEffectfulRetainedCallback,
  transport,
  decorateResult,
  scopeManager,
  getActiveScopeOwner,
  nextInvocationId,
}: {
  importDescriptors: WebAssembly.ModuleImportDescriptor[];
  getInstance: () => WebAssembly.Instance;
  registry: RetainedEventHandlerRegistry;
  bufferSize: number;
  annotateTrap: (error: unknown, opts?: VoydTrapAnnotation) => Error;
  runEffectfulRetainedCallback: RetainedEffectfulCallbackRunner;
  transport: HostTransportAdapter;
  decorateResult?: (value: unknown) => unknown;
  scopeManager: RetainedCallbackScopeManager;
  getActiveScopeOwner: () => RetainedCallbackScopeOwner | undefined;
  nextInvocationId: () => number;
}): WebAssembly.Imports => {
  const callbackImportsByModule = new Map<
    string,
    Record<string, CallableFunction>
  >();

  importDescriptors
    .filter(
      (descriptor) =>
        (descriptor.module === CALLBACK_IMPORT_MODULE ||
          descriptor.module === BOUNDARY_CALLBACK_IMPORT_MODULE ||
          descriptor.module === RENDER_CALLBACK_IMPORT_MODULE ||
          descriptor.module === LEGACY_VX_CALLBACK_IMPORT_MODULE) &&
        descriptor.kind === "function",
    )
    .forEach((descriptor) => {
      const callbackExportName = retainedCallbackExportNameFrom(descriptor);
      if (!callbackExportName) {
        return;
      }
      const callbackImports =
        callbackImportsByModule.get(descriptor.module) ?? {};
      callbackImportsByModule.set(descriptor.module, callbackImports);
      callbackImports[descriptor.name] = ((handlerRef: unknown): number => {
        const retain =
          descriptor.module === RENDER_CALLBACK_IMPORT_MODULE
            ? (handler: WasmEventHandlerRef) =>
                scopeManager.retain(getActiveScopeOwner(), handler)
            : (handler: WasmEventHandlerRef) => registry.retain(handler);
        return retain((payload) => {
          const instance = getInstance();
          const rawCallbackExportName = `${callbackExportName}_effectful_raw`;
          const returnsVoid = hasExportedFunction({
            instance,
            name: `${callbackExportName}_returns_void`,
          });
          const hasRawEffectfulCallback =
            hasExportedFunction({ instance, name: rawCallbackExportName }) &&
            hasExportedFunction({ instance, name: "init_effects" }) &&
            hasExportedFunction({ instance, name: OUTCOME_TAG_EXPORT }) &&
            hasExportedFunction({
              instance,
              name: RESUME_EFFECTFUL_RAW_EXPORT,
            }) &&
            hasExportedFunction({ instance, name: END_REQUEST_RAW_EXPORT }) &&
            hasExportedFunction({ instance, name: HANDLE_OUTCOME_EXPORT });
          if (returnsVoid && hasRawEffectfulCallback) {
            const outcome = runEffectfulRetainedCallback({
              callbackExportName,
              handlerRef,
              payload,
            });
            return outcome.then(() => undefined);
          }
          const callback = requireExportedFunction({
            instance,
            name: callbackExportName,
          });
          const msgpackMemory = requireExportedMemory({
            instance,
            name: LINEAR_MEMORY_EXPORT,
          });
          const invocationId = nextInvocationId();
          const encodedPayload = transport.encodeFrame({
            kind: "callback-invocation",
            invocationId,
            callbackId: 0,
            args: [
              {
                fingerprint: `callback:${callbackExportName}`,
                value: payload,
              },
            ],
          });
          if (encodedPayload.length > bufferSize) {
            throw new Error("retained callback payload exceeds buffer size");
          }
          ensureMemoryCapacity({
            memory: msgpackMemory,
            requiredBytes: bufferSize * 2,
            label: LINEAR_MEMORY_EXPORT,
          });
          const inPtr = 0;
          const outPtr = bufferSize;
          new Uint8Array(
            msgpackMemory.buffer,
            inPtr,
            encodedPayload.length,
          ).set(encodedPayload);

          let written: number;
          try {
            written = (callback as CallableFunction)(
              handlerRef,
              inPtr,
              encodedPayload.length,
              outPtr,
              bufferSize,
            ) as number;
          } catch (error) {
            if (hasRawEffectfulCallback) {
              const outcome = runEffectfulRetainedCallback({
                callbackExportName,
                handlerRef,
                payload,
              });
              return returnsVoid ? outcome.then(() => undefined) : outcome;
            }
            throw annotateTrap(error, {
              transition: {
                point: "retained_callback",
                direction: "host->vm",
              },
              fallbackFunctionName: callbackExportName,
            });
          }
          if (written === -2 && returnsVoid) {
            return undefined;
          }
          if (written < 0) {
            throw new Error("retained callback encoding failed");
          }
          if (written > bufferSize) {
            throw new Error("retained callback payload exceeds buffer size");
          }
          const bytes = new Uint8Array(msgpackMemory.buffer, outPtr, written);
          const completion = transport.decodeFrame(bytes);
          if (
            completion.kind !== "callback-completion" ||
            completion.invocationId !== invocationId
          ) {
            throw new Error("retained callback returned an incompatible frame");
          }
          if (completion.outcome.kind === "failure") {
            throw new Error(completion.outcome.failure.message);
          }
          const result = completion.outcome.value.value;
          return decorateResult?.(result) ?? result;
        });
      }) as CallableFunction;
    });

  return Object.fromEntries(
    callbackImportsByModule.entries(),
  ) as WebAssembly.Imports;
};

const buildRetainedCallbackScopeImportModule = ({
  importDescriptors,
  getActiveScopeOwner,
  scopeManager,
}: {
  importDescriptors: WebAssembly.ModuleImportDescriptor[];
  getActiveScopeOwner: () => RetainedCallbackScopeOwner | undefined;
  scopeManager: RetainedCallbackScopeManager;
}): WebAssembly.Imports => {
  const importedNames = new Set(
    importDescriptors
      .filter(
        (descriptor) =>
          descriptor.module === CALLBACK_SCOPE_IMPORT_MODULE &&
          descriptor.kind === "function",
      )
      .map((descriptor) => descriptor.name),
  );
  if (importedNames.size === 0) {
    return {};
  }

  const requireActiveScopeOwner = (): RetainedCallbackScopeOwner => {
    const owner = getActiveScopeOwner();
    if (owner === undefined) {
      throw new Error("retained callback scopes require an active Voyd task");
    }
    return owner;
  };
  const imports: Record<string, CallableFunction> = {};
  if (importedNames.has("begin")) {
    imports.begin = (() =>
      scopeManager.beginScope(requireActiveScopeOwner())) as CallableFunction;
  }
  if (importedNames.has("end")) {
    imports.end = ((scopeId: number) =>
      scopeManager.endScope(
        requireActiveScopeOwner(),
        scopeId,
      )) as CallableFunction;
  }
  if (importedNames.has("claim")) {
    imports.claim = ((handlerId: number) =>
      scopeManager.claim(
        requireActiveScopeOwner(),
        handlerId,
      )) as CallableFunction;
  }
  return { [CALLBACK_SCOPE_IMPORT_MODULE]: imports };
};

const retainedCallbackExportNameFrom = (
  descriptor: WebAssembly.ModuleImportDescriptor,
): string | undefined => {
  const importName = descriptor.name;
  if (
    descriptor.module === CALLBACK_IMPORT_MODULE &&
    importName.startsWith("retain__")
  ) {
    return importName.slice("retain__".length);
  }
  if (
    descriptor.module === RENDER_CALLBACK_IMPORT_MODULE &&
    importName.startsWith("retain_render_callback__")
  ) {
    return importName.slice("retain_render_callback__".length);
  }
  if (importName.startsWith("retain_callback__")) {
    return importName.slice("retain_callback__".length);
  }
  if (importName.startsWith("retain_event__")) {
    return importName.slice("retain_event__".length);
  }
  return undefined;
};

const isImportModuleRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const mergeDefaultImports = (
  defaults: WebAssembly.Imports,
  imports?: WebAssembly.Imports,
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
  Object.keys(defaultModules).forEach((moduleName) => {
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

  const initEffectsFn = requireExportedFunction({
    instance,
    name: "init_effects",
  });
  initEffectsFn(tablePtr);
};

export const createVoydHost = async ({
  wasm,
  imports,
  bufferSize = MIN_EFFECT_BUFFER_SIZE,
  scheduler,
  defaultAdapters = true,
  retainedCallbacks,
  adapters = [],
  transportAdapters = [],
}: HostInitOptions): Promise<VoydHost> => {
  const module = toModule(wasm);
  const trapDiagnostics = createVoydTrapDiagnostics({ module });
  let instanceRef: WebAssembly.Instance | undefined;
  let activeTaskImportContext: ActiveTaskImportContext | undefined;
  let activeCallbackScopeOwner: RetainedCallbackScopeOwner | undefined;
  let spawnDetachedOutsideContext:
    | ((params: {
        starterExportName: string;
        workArgs: readonly unknown[];
      }) => number)
    | undefined;
  const annotateTrap = (error: unknown, opts?: VoydTrapAnnotation): Error => {
    const panic = consumePanicContext({ instance: instanceRef });
    return trapDiagnostics.annotateTrap(error, {
      ...opts,
      ...(panic ? { panic } : {}),
    });
  };
  const parsedTable = parseEffectTable(module, EFFECT_TABLE_EXPORT);
  const table = toHostProtocolTable(parsedTable);
  const exportAbi = parseExportAbi(module);
  const transport = resolveHostTransport({
    metadata: exportAbi.host,
    adapters: transportAdapters,
  });
  const externalRequirements = parseExternalRequirements(module);
  const exportAbiByName = new Map(
    exportAbi.exports.map((entry) => [entry.name, entry] as const),
  );
  const taskRuntimeImports = buildTaskRuntimeImportModule({
    importDescriptors: WebAssembly.Module.imports(module),
    getContext: () => activeTaskImportContext,
    spawnDetachedOutsideContext: (params) => {
      if (!spawnDetachedOutsideContext) {
        throw new Error("detached task runtime is not initialized");
      }
      return spawnDetachedOutsideContext(params);
    },
  });
  const callbackRegistry =
    retainedCallbacks ?? createRetainedEventHandlerRegistry();
  const callbackScopeManager =
    createRetainedCallbackScopeManager(callbackRegistry);
  type StandaloneTaskEntry = {
    outcome: Promise<RunOutcome<unknown>>;
    cleanupTimer?: ReturnType<typeof setTimeout>;
  };
  const standaloneTaskRuns = new Map<number, StandaloneTaskEntry>();
  let nextStandaloneTaskId = 1_000_000;
  let nextRetainedCallbackInvocationId = 1;
  const observeStandaloneTask = async (
    taskId: number,
  ): Promise<RunOutcome<unknown>> => {
    const entry = standaloneTaskRuns.get(taskId);
    if (!entry) {
      return {
        kind: "failed",
        error: new Error(`unknown task ${taskId}`),
      };
    }
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
      entry.cleanupTimer = undefined;
    }
    return entry.outcome.finally(() => {
      standaloneTaskRuns.delete(taskId);
    });
  };
  let runEffectfulRetainedCallback: RetainedEffectfulCallbackRunner = () => {
    throw new Error(
      "retained callback called before host runtime initialization",
    );
  };
  const retainedCallbackImports = buildRetainedCallbackImportModules({
    importDescriptors: WebAssembly.Module.imports(module),
    getInstance: () => {
      if (!instanceRef) {
        throw new Error(
          "callback import called before host instance initialization",
        );
      }
      return instanceRef;
    },
    registry: callbackRegistry,
    bufferSize,
    annotateTrap,
    runEffectfulRetainedCallback: (params) =>
      runEffectfulRetainedCallback(params),
    transport,
    decorateResult: (value) => attachTaskObserver(value, observeStandaloneTask),
    scopeManager: callbackScopeManager,
    getActiveScopeOwner: () => activeCallbackScopeOwner,
    nextInvocationId: () => nextRetainedCallbackInvocationId++,
  });
  const retainedCallbackScopeImports = buildRetainedCallbackScopeImportModule({
    importDescriptors: WebAssembly.Module.imports(module),
    scopeManager: callbackScopeManager,
    getActiveScopeOwner: () => activeCallbackScopeOwner,
  });
  const externalImports = buildExternalImportModule({
    requirements: externalRequirements,
    adapters,
    bufferSize,
    getInstance: () => {
      if (!instanceRef) {
        throw new Error(
          "external import called before host instance initialization",
        );
      }
      return instanceRef;
    },
    transport,
  });
  instanceRef = new WebAssembly.Instance(
    module,
    mergeDefaultImports(
      {
        ...defaultImports(),
        ...(taskRuntimeImports as Record<string, unknown>),
        ...(retainedCallbackImports as Record<string, unknown>),
        ...(retainedCallbackScopeImports as Record<string, unknown>),
        ...(externalImports as Record<string, unknown>),
      } as WebAssembly.Imports,
      imports,
    ),
  );
  const instance = instanceRef;
  if (externalRequirements.functions.length > 0) {
    ensureMemoryCapacity({
      memory: requireExportedMemory({ instance, name: LINEAR_MEMORY_EXPORT }),
      requiredBytes: bufferSize * 2,
      label: LINEAR_MEMORY_EXPORT,
    });
  }

  const handlersByKey = new Map<string, EffectHandler>();
  const opByKey = buildParsedEffectOpMap({ ops: parsedTable.ops });
  const runtime = detectHostRuntime();
  const runtimeScheduler = createRuntimeScheduler({
    ...scheduler,
    scheduleTask: scheduler?.scheduleTask ?? scheduleTaskForRuntime(runtime),
  });
  const effectRunBufferBasePtr = alignTo(
    handleTableBasePtr(bufferSize) + parsedTable.ops.length * 4,
    8,
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
    handler: EffectHandler,
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

  registerExternalAdapterHandlers({
    requirements: externalRequirements,
    adapters,
    table,
    registerHandler,
  });

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

  const runSerialized = <T = unknown>(
    entryName: string,
    args: unknown[] = [],
    abi: Extract<ExportAbiEntry, { abi: "serialized" }>,
  ): T => {
    const wrapperName = abi?.wrapperName ?? entryName;
    const entry = requireExportedFunction({ instance, name: wrapperName });
    const msgpackMemory = requireExportedMemory({
      instance,
      name: LINEAR_MEMORY_EXPORT,
    });
    ensureMemoryCapacity({
      memory: msgpackMemory,
      requiredBytes: bufferSize * 2,
      label: LINEAR_MEMORY_EXPORT,
    });

    const boundaryArgs = abi?.params
      ? encodeBoundaryArgs({
          exportName: entryName,
          schemas: abi.params,
          args,
        })
      : args;
    const encodedArgs = transport.encodeFrame({
      kind: "export-invocation",
      exportId: abi.id,
      args: boundaryArgs.map((value, index) => ({
        fingerprint:
          abi.params?.[index]?.fingerprint ?? `export:${abi.id}:arg${index}`,
        value,
      })),
    });
    if (encodedArgs.length > bufferSize) {
      throw new Error(
        `serialized export ${entryName} args exceed buffer size (${encodedArgs.length} > ${bufferSize}); increase createVoydHost({ bufferSize }) or pass a smaller payload`,
      );
    }
    const inPtr = 0;
    const outPtr = bufferSize;
    new Uint8Array(msgpackMemory.buffer, inPtr, encodedArgs.length).set(
      encodedArgs,
    );
    let written: number;
    try {
      written = (entry as CallableFunction)(
        inPtr,
        encodedArgs.length,
        outPtr,
        bufferSize,
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
      throw new Error(
        `serialized export ${entryName} result encoding failed (bufferSize=${bufferSize}); increase createVoydHost({ bufferSize }) or return a smaller payload`,
      );
    }
    if (written > bufferSize) {
      throw new Error(
        `serialized export ${entryName} result exceeds buffer size (${written} > ${bufferSize}); increase createVoydHost({ bufferSize }) or return a smaller payload`,
      );
    }
    const bytes = new Uint8Array(msgpackMemory.buffer, outPtr, written);
    const completion = transport.decodeFrame(bytes);
    if (
      completion.kind !== "export-completion" ||
      completion.exportId !== abi.id
    ) {
      throw new Error(
        `serialized export ${entryName} returned an incompatible host frame`,
      );
    }
    if (completion.outcome.kind === "failure") {
      const { code, message, path } = completion.outcome.failure;
      const at = path && path.length > 0 ? ` at ${path.join(".")}` : "";
      throw new Error(
        `serialized export ${entryName} failed (${code})${at}: ${message}`,
      );
    }
    const expectedFingerprint = abi.result?.fingerprint;
    if (
      expectedFingerprint &&
      completion.outcome.value.fingerprint !== expectedFingerprint
    ) {
      throw new Error(
        `serialized export ${entryName} result fingerprint mismatch`,
      );
    }
    const decoded = completion.outcome.value.value;
    return (
      abi.result
        ? decodeBoundaryResult({
            exportName: entryName,
            schema: abi.result,
            value: decoded,
          })
        : decoded
    ) as T;
  };

  const runPure = async <T = unknown>(
    entryName: string,
    args: unknown[] = [],
  ): Promise<T> => {
    const callbackScopeOwner = `pure:${detachedRunCounter++}`;
    const previousCallbackScopeOwner = activeCallbackScopeOwner;
    activeCallbackScopeOwner = callbackScopeOwner;
    let didFail = false;
    try {
      const abi = exportAbiByName.get(entryName);
      if (abi?.abi === "serialized") {
        return runSerialized<T>(entryName, args, abi);
      }
      const entry = requireExportedFunction({ instance, name: entryName });
      const directArgs = abi?.params
        ? encodeDirectBoundaryArgs({
            exportName: entryName,
            schemas: abi.params,
            args,
          })
        : args;
      let result: unknown;
      try {
        result = (entry as (...params: unknown[]) => unknown)(...directArgs);
      } catch (error) {
        throw annotateTrap(error, {
          transition: {
            point: "run_pure_entry",
            direction: "host->vm",
          },
          fallbackFunctionName: entryName,
        });
      }
      return (
        abi?.result
          ? decodeDirectBoundaryResult({
              exportName: entryName,
              schema: abi.result,
              value: result,
            })
          : result
      ) as T;
    } catch (error) {
      didFail = true;
      throw error;
    } finally {
      activeCallbackScopeOwner = previousCallbackScopeOwner;
      try {
        callbackScopeManager.finishOwner(callbackScopeOwner);
      } catch (cleanupError) {
        if (!didFail) {
          throw cleanupError;
        }
        console.error(
          `[voyd] retained callback scope cleanup failed for ${callbackScopeOwner}: ${toError(cleanupError).message}`,
        );
      }
    }
  };

  const runEffectfulManaged = <T = unknown>(
    entryName: string,
    args: unknown[] = [],
    startRaw?: RawEffectfulStarter,
    completionOverride?: HostCompletionIdentity,
  ): VoydRunHandle<T> => {
    const callbackScopeRunId = detachedRunCounter++;
    const callbackScopeOwnerForTask = (taskId: number): string =>
      `${callbackScopeRunId}:${taskId}`;
    if (args.length > 0 && !startRaw) {
      throw new Error("effectful exports do not accept arguments yet");
    }
    if (!initialized) {
      initEffects();
    }
    const rootCompletion =
      completionOverride ??
      (() => {
        const abiName = entryName.endsWith("_effectful")
          ? entryName.slice(0, -"_effectful".length)
          : entryName;
        const abi = exportAbiByName.get(abiName);
        if (!abi) {
          throw new Error(
            `effectful export ${entryName} is missing ABI metadata`,
          );
        }
        return { kind: "export", id: abi.id } as const;
      })();

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
    const runResourceCleanups = new Set<EffectResourceCleanup>();
    let runResourceCleanupPromise: Promise<void> | undefined;
    let runResourceScopeClosed = false;
    const reportResourceCleanupFailure = (reason: unknown): void => {
      const error = toError(reason);
      console.error(`[voyd] run resource cleanup failed: ${error.message}`);
    };
    const reportRetainedCallbackScopeCleanupFailure = (
      taskId: number,
      error: Error,
    ): void => {
      console.error(
        `[voyd] retained callback scope cleanup failed for task ${taskId}: ${error.message}`,
      );
    };
    const finishRetainedCallbackScopesForTask = (
      taskId: number,
    ): Error | undefined => {
      try {
        callbackScopeManager.finishOwner(callbackScopeOwnerForTask(taskId));
        return undefined;
      } catch (reason) {
        return toError(reason);
      }
    };
    const registerRunResourceCleanup = (
      cleanup: EffectResourceCleanup,
    ): void => {
      if (runResourceScopeClosed) {
        void Promise.resolve()
          .then(cleanup)
          .catch(reportResourceCleanupFailure);
        return;
      }
      runResourceCleanups.add(cleanup);
    };
    const cleanupRunResources = (): Promise<void> => {
      if (runResourceCleanupPromise) {
        return runResourceCleanupPromise;
      }
      runResourceScopeClosed = true;
      const cleanups = Array.from(runResourceCleanups);
      runResourceCleanups.clear();
      runResourceCleanupPromise = Promise.allSettled(
        cleanups.map((cleanup) => Promise.resolve().then(cleanup)),
      ).then((results) => {
        results.forEach((result) => {
          if (result.status === "rejected") {
            reportResourceCleanupFailure(result.reason);
          }
        });
      });
      return runResourceCleanupPromise;
    };

    const rawEntryName = `${effectfulExportNameFor(entryName)}_raw`;
    const hasRawTaskRuntime =
      (startRaw !== undefined ||
        hasExportedFunction({ instance, name: rawEntryName })) &&
      hasExportedFunction({ instance, name: OUTCOME_TAG_EXPORT }) &&
      hasExportedFunction({ instance, name: RESUME_EFFECTFUL_RAW_EXPORT }) &&
      hasExportedFunction({ instance, name: END_REQUEST_RAW_EXPORT });

    if (!hasRawTaskRuntime) {
      const entry = startRaw
        ? undefined
        : requireExportedFunction({
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
            result = startRaw
              ? startRaw({ bufferPtr, bufferSize })
              : entry!(bufferPtr, bufferSize);
          } catch (error) {
            throw annotateTrap(error, {
              transition: {
                point: "run_effectful_entry",
                direction: "host->vm",
              },
              fallbackFunctionName: startRaw
                ? entryName
                : effectfulExportNameFor(entryName),
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
              transport,
              registerResourceCleanup: registerRunResourceCleanup,
              annotateTrap,
              fallbackFunctionName: startRaw
                ? entryName
                : effectfulExportNameFor(entryName),
              completion: rootCompletion,
            });
            if (stepResult.kind === "value") {
              return { kind: "value", value: stepResult.value };
            }
            if (stepResult.kind === "aborted") {
              return {
                kind: "failed",
                error: new Error(
                  "effect loop step aborted outside scheduler context",
                ),
              };
            }
            result = stepResult.result;
          }
        } catch (error) {
          return { kind: "failed", error: toError(error) };
        }
      })();

      const managedOutcome = outcome.finally(async () => {
        await cleanupRunResources();
        releaseEffectRunBufferPtr(bufferPtr);
      });

      return {
        id,
        outcome: managedOutcome,
        cancel: () => false,
      };
    }

    const rawEntry = startRaw
      ? undefined
      : requireExportedFunction({
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

    type TaskTerminalMetadata = {
      observed: boolean;
      reportedUnhandled?: boolean;
    };
    type TaskTerminal =
      | ({
          kind: "value";
          rawOutcome: unknown;
          value: unknown;
        } & TaskTerminalMetadata)
      | ({
          kind: "failed";
          error: Error;
          message: string;
        } & TaskTerminalMetadata)
      | ({ kind: "cancelled"; reason?: unknown } & TaskTerminalMetadata);
    type FailedTaskTerminal = Extract<TaskTerminal, { kind: "failed" }>;

    type TaskRecord = {
      id: number;
      ownerId: number | null;
      detached: boolean;
      sourceFunctionName: string;
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
      publicOutcome?: RunOutcome<T>;
      onTaskTerminal?: (taskId: number) => void;
    };

    const effectFramesByRequest = new Map<
      unknown,
      { requestId: number; resultFingerprint: string }
    >();

    const encodeToBuffer = (request: unknown, value: unknown): number => {
      const frame = effectFramesByRequest.get(request);
      if (!frame) {
        throw new Error("effect request is missing frame metadata");
      }
      const encoded = transport.encodeFrame({
        kind: "effect-outcome",
        requestId: frame.requestId,
        outcome: {
          kind: "success",
          value: { fingerprint: frame.resultFingerprint, value },
        },
      });
      if (encoded.length > bufferSize) {
        throw new Error("resume payload exceeds buffer size");
      }
      new Uint8Array(msgpackMemory.buffer, bufferPtr, encoded.length).set(
        encoded,
      );
      return encoded.length;
    };

    let resolvePublicOutcome: ((outcome: RunOutcome<T>) => void) | undefined;
    const publicOutcome = new Promise<RunOutcome<T>>((resolve) => {
      resolvePublicOutcome = resolve;
    });
    if (!resolvePublicOutcome) {
      throw new Error("failed to initialize public run outcome promise");
    }

    const taskObservers = new Map<
      number,
      {
        resolve: (outcome: RunOutcome<unknown>) => void;
        promise: Promise<RunOutcome<unknown>>;
      }
    >();
    const completedTaskOutcomes = new Map<number, RunOutcome<unknown>>();

    const decodeRawOutcome = (
      rawOutcome: unknown,
      completion: HostCompletionIdentity,
    ): unknown => {
      const effectResult = handleOutcome(
        rawOutcome,
        bufferPtr,
        bufferSize,
        completion.kind === "export" ? 0 : 1,
        completion.id,
      );
      const payloadLength = effectLen(effectResult) as number;
      if (!Number.isSafeInteger(payloadLength) || payloadLength < 0) {
        throw new Error(
          `task outcome encoding failed (len=${String(payloadLength)}, bufferSize=${bufferSize})`,
        );
      }
      if (payloadLength > bufferSize) {
        throw new Error(
          `task outcome payload exceeds buffer size (len=${payloadLength}, bufferSize=${bufferSize})`,
        );
      }
      try {
        return decodeHostCompletion({
          memory: msgpackMemory,
          ptr: bufferPtr,
          length: payloadLength,
          transport,
          completion,
        });
      } catch (error) {
        throw new Error("task outcome decoding failed", {
          cause: toError(error),
        });
      }
    };

    const taskRunOutcomeFor = (terminal: TaskTerminal): RunOutcome<unknown> => {
      if (terminal.kind === "failed")
        return { kind: "failed", error: terminal.error };
      if (terminal.kind === "cancelled") {
        return { kind: "cancelled", reason: terminal.reason };
      }
      return { kind: "value", value: terminal.value };
    };

    const notifyTaskTerminal = (task: TaskRecord): void => {
      if (!task.terminal) return;
      const outcome = taskRunOutcomeFor(task.terminal);
      if (task.detached) {
        completedTaskOutcomes.set(task.id, outcome);
      }
      const observer = taskObservers.get(task.id);
      if (!observer) return;
      taskObservers.delete(task.id);
      task.terminal.observed = true;
      observer.resolve(outcome);
    };

    const settlePublicOutcome = (
      state: RunState,
      outcome: RunOutcome<T>,
    ): void => {
      if (state.publicOutcome) return;
      state.publicOutcome = outcome;
      resolvePublicOutcome?.(outcome);
    };

    const runWithActiveTask = <R>(
      context: ActiveTaskContext,
      fn: () => R,
    ): R => {
      const previous = activeTaskImportContext;
      const previousCallbackScopeOwner = activeCallbackScopeOwner;
      activeTaskImportContext = context;
      activeCallbackScopeOwner = context.callbackScopeOwner;
      try {
        return fn();
      } finally {
        activeTaskImportContext = previous;
        activeCallbackScopeOwner = previousCallbackScopeOwner;
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
      callbackScopeOwner: callbackScopeOwnerForTask(activeTaskId),
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
          const length = encodeToBuffer(request, value);
          return resumeEffectfulRaw(request, bufferPtr, length);
        },
      );

    const currentActiveTaskId = (): number | null => {
      const active = activeTaskImportContext as ActiveTaskContext | undefined;
      return active?.activeTaskId ?? null;
    };

    const getFailedTerminal = (
      terminal?: TaskTerminal,
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
      resumeKind:
        opEntry.resumeKind === 1 ? ("tail" as const) : ("resume" as const),
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
        error.message === message
          ? error
          : new Error(message, { cause: error });
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
          `[voyd] unhandled detached task failure in run ${run.id}: ${message}`,
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
            workArgs,
          }: {
            detached: boolean;
            starterExportName: string;
            workArgs: readonly unknown[];
          }): number => {
            const ownerId = currentActiveTaskId();
            const taskId = state.nextTaskId++;
            const sourceFunctionName =
              ownerId === null
                ? starterExportName
                : (state.tasks.get(ownerId)?.sourceFunctionName ??
                  starterExportName);
            const starter = requireExportedFunction({
              instance,
              name: starterExportName,
            });
            state.tasks.set(taskId, {
              id: taskId,
              ownerId: detached ? null : ownerId,
              detached,
              sourceFunctionName,
              state: "ready",
              starter: () =>
                runWithActiveTask(
                  toActiveTaskContext({
                    state,
                    activeTaskId: taskId,
                  }),
                  () => {
                    try {
                      return starter(...workArgs);
                    } catch (error) {
                      throw annotateTrap(error, {
                        transition: {
                          point: "effectful_entry",
                          direction: "host->vm",
                        },
                        fallbackFunctionName: sourceFunctionName,
                      });
                    }
                  },
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
              finishRetainedCallbackScopesForTask(taskId);
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
              notifyTaskTerminal(task);
              state.onTaskTerminal?.(taskId);
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
          sourceFunctionName: entryName,
          state: "ready",
          starter: () =>
            runWithActiveTask(
              toActiveTaskContext({
                state,
                activeTaskId: rootTaskId,
              }),
              () => {
                try {
                  return startRaw
                    ? startRaw({ bufferPtr, bufferSize })
                    : rawEntry!(bufferPtr, bufferSize);
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
        const wakeRun = ():
          | RuntimeStepResult<T>
          | Promise<RuntimeStepResult<T>> => {
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
          if (
            !task ||
            task.state === "terminal" ||
            task.state === "completing"
          ) {
            return { kind: "next", result: state };
          }

          const finalizeIfDone = (): void => {
            const rootTask = state.tasks.get(state.rootTaskId);
            if (!rootTask?.terminal) {
              return;
            }
            const tasks = Array.from(state.tasks.values());
            const hasDetachedAncestor = (task: TaskRecord): boolean => {
              let ownerId = task.ownerId;
              while (ownerId !== null) {
                const owner = state.tasks.get(ownerId);
                if (!owner) return false;
                if (owner.detached) return true;
                ownerId = owner.ownerId;
              }
              return false;
            };
            const liveBlockingTaskCount = tasks.filter(
              (entry) =>
                entry.state !== "terminal" &&
                !entry.detached &&
                !hasDetachedAncestor(entry),
            ).length;
            if (liveBlockingTaskCount === 0 && !state.publicOutcome) {
              if (rootTask.terminal.kind === "value") {
                settlePublicOutcome(state, {
                  kind: "value",
                  value: rootTask.terminal.value as T,
                });
              } else if (rootTask.terminal.kind === "failed") {
                settlePublicOutcome(state, {
                  kind: "failed",
                  error: rootTask.terminal.error,
                });
              } else {
                settlePublicOutcome(state, {
                  kind: "cancelled",
                  reason: rootTask.terminal.reason,
                });
              }
            }

            const liveTaskCount = tasks.filter(
              (entry) => entry.state !== "terminal",
            ).length;
            if (liveTaskCount > 0 || !state.publicOutcome) {
              return;
            }
            state.finalOutcome = state.publicOutcome;
          };

          state.onTaskTerminal = (taskId: number): void => {
            const task = state.tasks.get(taskId);
            if (!task) {
              return;
            }
            if (task.ownerId !== null) {
              maybeCompleteOwner(task.ownerId);
            }
            finalizeIfDone();
          };

          const liveChildrenFor = (task: TaskRecord): TaskRecord[] =>
            Array.from(task.children)
              .map((childId) => state.tasks.get(childId))
              .filter(
                (entry): entry is TaskRecord =>
                  !!entry && entry.state !== "terminal",
              );

          type TaskSettlement = {
            task: TaskRecord;
            completion: TaskCompletion;
            unobservedFailure?: FailedTaskTerminal;
          };

          const buildTaskTerminal = ({
            task,
            completion,
            unobservedFailure,
          }: TaskSettlement): TaskTerminal => {
            const cleanupFailure = finishRetainedCallbackScopesForTask(task.id);
            if (
              completion.kind === "value" &&
              !unobservedFailure &&
              cleanupFailure
            ) {
              return {
                kind: "failed",
                error: cleanupFailure,
                message: cleanupFailure.message,
                observed: false,
              };
            }
            if (cleanupFailure) {
              reportRetainedCallbackScopeCleanupFailure(
                task.id,
                cleanupFailure,
              );
            }
            if (completion.kind === "value" && unobservedFailure) {
              return {
                kind: "failed",
                error: new Error(
                  `unobserved child task failure: ${unobservedFailure.message}`,
                ),
                message: unobservedFailure.message,
                observed: false,
              };
            }
            if (completion.kind !== "value") {
              return { ...completion, observed: false };
            }
            try {
              return {
                ...completion,
                value: decodeRawOutcome(
                  completion.rawOutcome,
                  task.ownerId === null
                    ? rootCompletion
                    : { kind: "callback", id: task.id },
                ),
                observed: false,
              };
            } catch (error) {
              const normalized = annotateTrap(error, {
                transition: {
                  point: "task_outcome",
                  direction: "vm->host",
                },
                fallbackFunctionName: task.sourceFunctionName,
              });
              return {
                kind: "failed",
                error: normalized,
                message: taskFailureMessage(normalized),
                observed: false,
              };
            }
          };

          const terminalForCompletion = (
            settlement: TaskSettlement,
          ): TaskTerminal => {
            try {
              return buildTaskTerminal(settlement);
            } catch (error) {
              const normalized = toError(error);
              return {
                kind: "failed",
                error: normalized,
                message: taskFailureMessage(normalized),
                observed: false,
              };
            }
          };

          const maybeCompleteOwner = (taskId: number): void => {
            const owner = state.tasks.get(taskId);
            if (
              !owner ||
              owner.state !== "completing" ||
              !owner.pendingCompletion
            ) {
              return;
            }
            const liveChildren = liveChildrenFor(owner);
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
            owner.terminal = terminalForCompletion({
              task: owner,
              completion: pending,
              unobservedFailure,
            });
            owner.state = "terminal";
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
            notifyTaskTerminal(owner);
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

          const completeTask = (
            taskId: number,
            completion: TaskCompletion,
          ): void => {
            const current = state.tasks.get(taskId);
            if (
              !current ||
              current.state === "completing" ||
              current.state === "terminal"
            ) {
              return;
            }
            if (completion.kind !== "value") {
              current.children.forEach((childId) => {
                state.cancelTask(childId);
              });
            }
            const liveChildren = liveChildrenFor(current);
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
            current.pendingCompletion = undefined;
            current.pendingResume = undefined;
            current.terminal = terminalForCompletion({
              task: current,
              completion,
              unobservedFailure,
            });
            current.state = "terminal";
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
            notifyTaskTerminal(current);
            const currentFailure = getFailedTerminal(current.terminal);
            if (
              current.detached &&
              currentFailure &&
              !currentFailure.observed
            ) {
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
                  const length = encodeToBuffer(request, handlerResult.value);
                  return handlerResult.kind === "end"
                    ? endRequestRaw(request, bufferPtr, length)
                    : resumeEffectfulRaw(request, bufferPtr, length);
                },
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

            const effectResult = handleOutcome(
              rawOutcome,
              bufferPtr,
              bufferSize,
              task.ownerId === null
                ? rootCompletion.kind === "export"
                  ? 0
                  : 1
                : 1,
              task.ownerId === null ? rootCompletion.id : task.id,
            );
            const payloadLength = effectLen(effectResult) as number;
            const request = effectCont(effectResult);
            const frame = transport.decodeFrame(
              new Uint8Array(msgpackMemory.buffer, bufferPtr, payloadLength),
            );
            if (frame.kind !== "effect-request") {
              throw new Error(
                "effect boundary returned an incompatible host frame",
              );
            }
            const framedOp = parsedTable.ops[frame.requestId];
            if (
              !framedOp ||
              framedOp.effectId !== frame.effectId ||
              framedOp.opId !== frame.operationId ||
              framedOp.signatureHash !== frame.signatureHash >>> 0 ||
              framedOp.resumeKind !== frame.resumeKind
            ) {
              throw new Error(
                "effect request frame does not match the effect table",
              );
            }
            effectFramesByRequest.set(request, {
              requestId: frame.requestId,
              resultFingerprint: frame.resultFingerprint,
            });
            const decodedEffect: EffectOpRequest = {
              effectId: framedOp.effectIdHash.value,
              opId: framedOp.opId,
              opIndex: framedOp.opIndex,
              resumeKind: framedOp.resumeKind,
              handle: framedOp.opIndex,
              args: frame.args.map((payload) => payload.value),
            };
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

            const toContinuationCall = (
              kind: "resume" | "tail" | "end",
              value: unknown,
            ) => ({
              kind,
              value,
            });
            const handlerResult = handler(
              {
                resume: (...args: unknown[]) =>
                  toContinuationCall(
                    "resume",
                    args.length <= 1 ? args[0] : args,
                  ),
                tail: (...args: unknown[]) =>
                  toContinuationCall("tail", args.length <= 1 ? args[0] : args),
                end: (value: unknown) => toContinuationCall("end", value),
                registerResourceCleanup: registerRunResourceCleanup,
              },
              ...(decodedEffect.args ?? []),
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
                },
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
    const observeTask: NonNullable<VoydRunHandle["observeTask"]> = (taskId) => {
      const state = liveState;
      const task = state?.tasks.get(taskId);
      if (task?.terminal) {
        task.terminal.observed = true;
        const outcome =
          completedTaskOutcomes.get(taskId) ?? taskRunOutcomeFor(task.terminal);
        return Promise.resolve(outcome);
      }
      const completed = completedTaskOutcomes.get(taskId);
      if (completed) return Promise.resolve(completed);
      if (!task) {
        return Promise.resolve({
          kind: "failed",
          error: new Error(`unknown task ${taskId}`),
        });
      }
      const existing = taskObservers.get(taskId);
      if (existing) {
        return existing.promise;
      }
      let resolveObserver: ((outcome: RunOutcome<unknown>) => void) | undefined;
      const promise = new Promise<RunOutcome<unknown>>((resolve) => {
        resolveObserver = resolve;
      });
      if (!resolveObserver) {
        throw new Error("failed to initialize task observer promise");
      }
      taskObservers.set(taskId, { promise, resolve: resolveObserver });
      return promise;
    };

    const managedRun: VoydRunHandle<T> = {
      ...run,
      outcome: publicOutcome,
      observeTask,
      cancel: (reason?: unknown): boolean => {
        const cancelled = run.cancel(reason);
        if (cancelled) {
          const state = liveState;
          if (state) {
            settlePublicOutcome(state, { kind: "cancelled", reason });
          } else {
            resolvePublicOutcome?.({ kind: "cancelled", reason });
          }
          if (state) {
            Array.from(state.tasks.keys()).forEach((taskId) => {
              state.cancelTask(taskId);
            });
          }
        }
        return cancelled;
      },
    };
    const internalOutcomeWithCleanup = run.outcome.finally(async () => {
      await cleanupRunResources();
      liveState = undefined;
      releaseEffectRunBufferPtr(bufferPtr);
    });
    void internalOutcomeWithCleanup.catch(() => undefined);
    return managedRun;
  };

  spawnDetachedOutsideContext = ({ starterExportName, workArgs }) => {
    const starter = requireExportedFunction({
      instance,
      name: starterExportName,
    });
    const taskId = nextStandaloneTaskId++;
    const run = runEffectfulManaged<unknown>(
      starterExportName,
      [],
      () => starter(...workArgs),
      { kind: "callback", id: taskId },
    );
    const entry: StandaloneTaskEntry = { outcome: run.outcome };
    standaloneTaskRuns.set(taskId, entry);
    void run.outcome.finally(() => {
      if (standaloneTaskRuns.get(taskId) !== entry) return;
      const cleanupTimer = setTimeout(() => {
        standaloneTaskRuns.delete(taskId);
      }, 60_000);
      (cleanupTimer as { unref?: () => void }).unref?.();
      entry.cleanupTimer = cleanupTimer;
    });
    return taskId;
  };

  runEffectfulRetainedCallback = async ({
    callbackExportName,
    handlerRef,
    payload,
  }) => {
    const rawCallbackExportName = `${callbackExportName}_effectful_raw`;
    const callback = requireExportedFunction({
      instance,
      name: rawCallbackExportName,
    });
    const msgpackMemory = requireExportedMemory({
      instance,
      name: LINEAR_MEMORY_EXPORT,
    });
    const invocationId = nextRetainedCallbackInvocationId++;
    const encodedPayload = transport.encodeFrame({
      kind: "callback-invocation",
      invocationId,
      callbackId: 0,
      args: [
        {
          fingerprint: `callback:${callbackExportName}`,
          value: payload,
        },
      ],
    });
    if (encodedPayload.length > bufferSize) {
      throw new Error("retained callback payload exceeds buffer size");
    }
    const managed = runEffectfulManaged(
      callbackExportName,
      [],
      ({ bufferPtr, bufferSize }) => {
        ensureMemoryCapacity({
          memory: msgpackMemory,
          requiredBytes: bufferPtr + bufferSize,
          label: LINEAR_MEMORY_EXPORT,
        });
        new Uint8Array(
          msgpackMemory.buffer,
          bufferPtr,
          encodedPayload.length,
        ).set(encodedPayload);
        try {
          return (callback as CallableFunction)(
            handlerRef,
            bufferPtr,
            encodedPayload.length,
            0,
            0,
          );
        } catch (error) {
          throw annotateTrap(error, {
            transition: {
              point: "retained_callback",
              direction: "host->vm",
            },
            fallbackFunctionName: rawCallbackExportName,
          });
        }
      },
      { kind: "callback", id: invocationId },
    );
    return attachTaskObserver(
      await unwrapRunOutcome(managed.outcome),
      managed.observeTask,
    );
  };

  const runManaged = <T = unknown>(
    entryName: string,
    args: unknown[] = [],
  ): VoydRunHandle<T> => {
    const effectfulName = effectfulExportNameFor(entryName);
    const hasEffectful = typeof instance.exports[effectfulName] === "function";
    if (hasEffectful) {
      return runEffectfulManaged<T>(entryName, args);
    }

    const id = `detached_${detachedRunCounter++}`;
    const outcome = runPure<T>(entryName, args)
      .then<RunOutcome<T>>((value) => ({ kind: "value", value }))
      .catch<RunOutcome<T>>((error) => ({
        kind: "failed",
        error: toError(error),
      }));
    return {
      id,
      outcome,
      cancel: () => false,
    };
  };

  const runEffectful = async <T = unknown>(
    entryName: string,
    args: unknown[] = [],
  ): Promise<T> => {
    const managed = runEffectfulManaged<T>(entryName, args);
    return attachTaskObserver(
      await unwrapRunOutcome(managed.outcome),
      managed.observeTask,
    );
  };

  const run = async <T = unknown>(
    entryName: string,
    args: unknown[] = [],
  ): Promise<T> => {
    const managed = runManaged<T>(entryName, args);
    return attachTaskObserver(
      await unwrapRunOutcome(managed.outcome),
      managed.observeTask,
    );
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
    hasExport: (entryName) =>
      hasExportedFunction({ instance, name: entryName }),
    runManaged,
    runEffectful,
    run,
    retainedCallbacks: callbackRegistry,
  };

  if (defaultAdapters !== false) {
    await host.registerDefaultAdapters(
      typeof defaultAdapters === "object" ? defaultAdapters : {},
    );
  }

  return host;
};
