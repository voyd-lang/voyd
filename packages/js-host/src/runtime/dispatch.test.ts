import { decode, encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import type { EffectOpRequest } from "../effect-op.js";
import type { ParsedEffectOp, ParsedEffectTable } from "../protocol/table.js";
import type { EffectHandler } from "../protocol/types.js";
import { continueEffectLoopStep, runEffectLoop } from "./dispatch.js";
import { EFFECT_RESULT_STATUS, RESUME_KIND } from "./constants.js";

const MSGPACK_OPTS = { useBigInt64: true } as const;
const BUFFER_PTR = 0;
const BUFFER_SIZE = 1024;

type FakeResult = {
  status: number;
  payload: unknown;
  cont?: symbol;
};

const EFFECT_HASH = {
  low: 1,
  high: 0,
  value: 1n,
  hex: "0x0000000000000001",
} as const;

const asNumber = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }
  throw new Error(`expected number, got ${typeof value}`);
};

const createParsedOp = ({
  resumeKind,
}: {
  resumeKind: ParsedEffectOp["resumeKind"];
}): ParsedEffectOp => ({
  opIndex: 0,
  effectId: "com.example.async",
  effectIdHash: EFFECT_HASH,
  opId: 7,
  resumeKind,
  signatureHash: 0x1234abcd,
  label: "Async.await",
});

const createParsedTable = ({
  op,
}: {
  op: ParsedEffectOp;
}): ParsedEffectTable => ({
  version: 2,
  tableExport: "__voyd_effect_table",
  names: new Uint8Array(),
  namesBase64: "",
  ops: [op],
  opsByEffectId: new Map([[op.effectId, [op]]]),
});

const createEffectRequest = ({
  args,
  resumeKind,
}: {
  args: unknown[];
  resumeKind: number;
}): EffectOpRequest => ({
  effectId: EFFECT_HASH.value,
  opId: 7,
  opIndex: 0,
  resumeKind,
  handle: 0,
  args,
});

const effectResult = ({
  request,
  cont,
}: {
  request: EffectOpRequest;
  cont: symbol;
}): FakeResult => ({
  status: EFFECT_RESULT_STATUS.effect,
  payload: request,
  cont,
});

const valueResult = (value: unknown): FakeResult => ({
  status: EFFECT_RESULT_STATUS.value,
  payload: value,
});

const createRuntimeDriver = ({
  entryResult,
  continuations,
}: {
  entryResult: FakeResult;
  continuations: Map<symbol, (resumeValue: unknown) => FakeResult>;
}) => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let resumeCalls = 0;

  const writePayload = (payload: unknown): number => {
    const encoded = encode(payload, MSGPACK_OPTS) as Uint8Array;
    new Uint8Array(memory.buffer, BUFFER_PTR, encoded.length).set(encoded);
    return encoded.length;
  };

  return {
    entry: () => entryResult,
    effectStatus: (result: FakeResult): number => result.status,
    effectCont: (result: FakeResult): symbol => {
      if (!result.cont) {
        throw new Error("missing continuation");
      }
      return result.cont;
    },
    effectLen: (result: FakeResult): number => writePayload(result.payload),
    resumeEffectful: (cont: symbol, ptr: number, length: number): FakeResult => {
      resumeCalls += 1;
      const bytes = new Uint8Array(memory.buffer, ptr, length);
      const decoded = decode(bytes, MSGPACK_OPTS);
      const resume = continuations.get(cont);
      if (!resume) {
        throw new Error("unknown continuation");
      }
      continuations.delete(cont);
      return resume(decoded);
    },
    msgpackMemory: memory,
    resumeCalls: (): number => resumeCalls,
  };
};

describe("runEffectLoop", () => {
  it("processes effect steps sequentially and preserves causal ordering", async () => {
    const op = createParsedOp({ resumeKind: RESUME_KIND.resume });
    const table = createParsedTable({ op });
    const trace: string[] = [];
    const contA = Symbol("cont-a");
    const contB = Symbol("cont-b");

    const runtime = createRuntimeDriver({
      entryResult: effectResult({
        request: createEffectRequest({ args: [1], resumeKind: RESUME_KIND.resume }),
        cont: contA,
      }),
      continuations: new Map([
        [
          contA,
          (resumeValue) => {
            trace.push(`resume:a:${asNumber(resumeValue)}`);
            return effectResult({
              request: createEffectRequest({
                args: [asNumber(resumeValue) + 1],
                resumeKind: RESUME_KIND.resume,
              }),
              cont: contB,
            });
          },
        ],
        [
          contB,
          (resumeValue) => {
            trace.push(`resume:b:${asNumber(resumeValue)}`);
            return valueResult(asNumber(resumeValue) * 10);
          },
        ],
      ]),
    });

    const handler: EffectHandler = async ({ resume }, arg) => {
      const value = asNumber(arg);
      trace.push(`handler:start:${value}`);
      await Promise.resolve();
      trace.push(`handler:end:${value}`);
      return resume(value + 1);
    };

    const output = await runEffectLoop<number>({
      entry: runtime.entry,
      effectStatus: runtime.effectStatus,
      effectCont: runtime.effectCont,
      effectLen: runtime.effectLen,
      resumeEffectful: runtime.resumeEffectful,
      table,
      handlersByOpIndex: [handler],
      msgpackMemory: runtime.msgpackMemory,
      bufferPtr: BUFFER_PTR,
      bufferSize: BUFFER_SIZE,
    });

    expect(output).toBe(40);
    expect(trace).toEqual([
      "handler:start:1",
      "handler:end:1",
      "resume:a:2",
      "handler:start:3",
      "handler:end:3",
      "resume:b:4",
    ]);
  });

  it("allows handlers to complete a run with end(...) without resuming wasm", async () => {
    const op = createParsedOp({ resumeKind: RESUME_KIND.resume });
    const table = createParsedTable({ op });
    const cont = Symbol("cont");
    const runtime = createRuntimeDriver({
      entryResult: effectResult({
        request: createEffectRequest({ args: [5], resumeKind: RESUME_KIND.resume }),
        cont,
      }),
      continuations: new Map([
        [
          cont,
          () => {
            throw new Error("resume should not be called");
          },
        ],
      ]),
    });

    const output = await runEffectLoop<number>({
      entry: runtime.entry,
      effectStatus: runtime.effectStatus,
      effectCont: runtime.effectCont,
      effectLen: runtime.effectLen,
      resumeEffectful: runtime.resumeEffectful,
      table,
      handlersByOpIndex: [({ end }) => end(99)],
      msgpackMemory: runtime.msgpackMemory,
      bufferPtr: BUFFER_PTR,
      bufferSize: BUFFER_SIZE,
    });

    expect(output).toBe(99);
    expect(runtime.resumeCalls()).toBe(0);
  });

  it("fails when no handler is registered for an emitted effect op", async () => {
    const op = createParsedOp({ resumeKind: RESUME_KIND.resume });
    const table = createParsedTable({ op });
    const runtime = createRuntimeDriver({
      entryResult: effectResult({
        request: createEffectRequest({ args: [1], resumeKind: RESUME_KIND.resume }),
        cont: Symbol("cont"),
      }),
      continuations: new Map(),
    });

    await expect(
      runEffectLoop({
        entry: runtime.entry,
        effectStatus: runtime.effectStatus,
        effectCont: runtime.effectCont,
        effectLen: runtime.effectLen,
        resumeEffectful: runtime.resumeEffectful,
        table,
        handlersByOpIndex: [],
        msgpackMemory: runtime.msgpackMemory,
        bufferPtr: BUFFER_PTR,
        bufferSize: BUFFER_SIZE,
      })
    ).rejects.toThrow(/Unhandled effect/i);
  });

  it("propagates async handler rejections as run failures", async () => {
    const op = createParsedOp({ resumeKind: RESUME_KIND.resume });
    const table = createParsedTable({ op });
    const runtime = createRuntimeDriver({
      entryResult: effectResult({
        request: createEffectRequest({ args: [1], resumeKind: RESUME_KIND.resume }),
        cont: Symbol("cont"),
      }),
      continuations: new Map(),
    });

    await expect(
      runEffectLoop({
        entry: runtime.entry,
        effectStatus: runtime.effectStatus,
        effectCont: runtime.effectCont,
        effectLen: runtime.effectLen,
        resumeEffectful: runtime.resumeEffectful,
        table,
        handlersByOpIndex: [
          async () => {
            throw new Error("boom");
          },
        ],
        msgpackMemory: runtime.msgpackMemory,
        bufferPtr: BUFFER_PTR,
        bufferSize: BUFFER_SIZE,
      })
    ).rejects.toThrow("boom");
  });

  it("fails with a clear error when wasm reports an invalid payload length", async () => {
    const op = createParsedOp({ resumeKind: RESUME_KIND.resume });
    const table = createParsedTable({ op });
    const runtime = createRuntimeDriver({
      entryResult: effectResult({
        request: createEffectRequest({ args: [1], resumeKind: RESUME_KIND.resume }),
        cont: Symbol("cont"),
      }),
      continuations: new Map(),
    });

    await expect(
      runEffectLoop({
        entry: runtime.entry,
        effectStatus: runtime.effectStatus,
        effectCont: runtime.effectCont,
        effectLen: () => -1,
        resumeEffectful: runtime.resumeEffectful,
        table,
        handlersByOpIndex: [({ resume }) => resume(1)],
        msgpackMemory: runtime.msgpackMemory,
        bufferPtr: BUFFER_PTR,
        bufferSize: BUFFER_SIZE,
      })
    ).rejects.toThrow(/payload encoding failed/i);
  });

  it("enforces resume-kind contracts before attempting resumption", async () => {
    const resumeOp = createParsedOp({ resumeKind: RESUME_KIND.resume });
    const resumeTable = createParsedTable({ op: resumeOp });
    const resumeRuntime = createRuntimeDriver({
      entryResult: effectResult({
        request: createEffectRequest({ args: [1], resumeKind: RESUME_KIND.resume }),
        cont: Symbol("resume-cont"),
      }),
      continuations: new Map(),
    });

    await expect(
      runEffectLoop({
        entry: resumeRuntime.entry,
        effectStatus: resumeRuntime.effectStatus,
        effectCont: resumeRuntime.effectCont,
        effectLen: resumeRuntime.effectLen,
        resumeEffectful: resumeRuntime.resumeEffectful,
        table: resumeTable,
        handlersByOpIndex: [({ tail }) => tail(2)],
        msgpackMemory: resumeRuntime.msgpackMemory,
        bufferPtr: BUFFER_PTR,
        bufferSize: BUFFER_SIZE,
      })
    ).rejects.toThrow(/cannot return tail/i);
    expect(resumeRuntime.resumeCalls()).toBe(0);

    const tailOp = createParsedOp({ resumeKind: RESUME_KIND.tail });
    const tailTable = createParsedTable({ op: tailOp });
    const tailRuntime = createRuntimeDriver({
      entryResult: effectResult({
        request: createEffectRequest({ args: [1], resumeKind: RESUME_KIND.tail }),
        cont: Symbol("tail-cont"),
      }),
      continuations: new Map(),
    });

    await expect(
      runEffectLoop({
        entry: tailRuntime.entry,
        effectStatus: tailRuntime.effectStatus,
        effectCont: tailRuntime.effectCont,
        effectLen: tailRuntime.effectLen,
        resumeEffectful: tailRuntime.resumeEffectful,
        table: tailTable,
        handlersByOpIndex: [({ resume }) => resume(2)],
        msgpackMemory: tailRuntime.msgpackMemory,
        bufferPtr: BUFFER_PTR,
        bufferSize: BUFFER_SIZE,
      })
    ).rejects.toThrow(/must return tail/i);
    expect(tailRuntime.resumeCalls()).toBe(0);
  });

  it("aborts late handler completions without resuming wasm when run is cancelled", async () => {
    const op = createParsedOp({ resumeKind: RESUME_KIND.resume });
    const table = createParsedTable({ op });
    const runtime = createRuntimeDriver({
      entryResult: effectResult({
        request: createEffectRequest({ args: [1], resumeKind: RESUME_KIND.resume }),
        cont: Symbol("cancelled-cont"),
      }),
      continuations: new Map(),
    });
    let resolveHandler: ((value: number) => void) | undefined;

    const stepPromise = continueEffectLoopStep<number>({
      result: runtime.entry(),
      effectStatus: runtime.effectStatus,
      effectCont: runtime.effectCont,
      effectLen: runtime.effectLen,
      resumeEffectful: runtime.resumeEffectful,
      table,
      handlersByOpIndex: [
        ({ resume }, arg) =>
          new Promise((resolve) => {
            resolveHandler = (value: number) => resolve(resume(value));
            expect(arg).toBe(1);
          }),
      ],
      msgpackMemory: runtime.msgpackMemory,
      bufferPtr: BUFFER_PTR,
      bufferSize: BUFFER_SIZE,
      shouldContinue: () => false,
    });

    resolveHandler?.(2);
    const result = await stepPromise;
    expect(result.kind).toBe("aborted");
    expect(runtime.resumeCalls()).toBe(0);
  });
});
