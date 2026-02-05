import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createSdk,
  type EffectHandler,
  type EffectsInfo,
} from "@voyd/sdk";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "effects-e2e.voyd"
);
const ASYNC_EFFECT_ID = "com.example.async";
const GENERIC_EFFECT_ID = "com.example.generic";

const assertNoCompileErrors = (
  diagnostics: { severity: string; message: string }[]
): void => {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length === 0) return;
  throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
};

const asNumber = (label: string, value: unknown): number => {
  if (typeof value === "number") return value;
  throw new Error(`expected ${label} arg to be a number, got ${typeof value}`);
};

const unsafeHandler = (
  handler: (...args: any[]) => unknown
): EffectHandler => handler as unknown as EffectHandler;

describe("smoke: effects e2e", () => {
  let compiled: Awaited<ReturnType<ReturnType<typeof createSdk>["compile"]>>;
  let effects: EffectsInfo;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = await sdk.compile({ entryPath: fixtureEntryPath });
    assertNoCompileErrors(compiled.diagnostics);
    effects = compiled.effects;
  });

  it("runs effect polymorphism where a pure function accepts effectful callbacks", async () => {
    const output = await compiled.run<number>({ entryName: "main" });
    expect(output).toBe(15);
  });

  it("runs internal handlers that always resume", async () => {
    const output = await compiled.run<number>({ entryName: "internal_resume_all" });
    expect(output).toBe(12);
  });

  it("runs internal handlers that choose not to resume", async () => {
    const output = await compiled.run<number>({ entryName: "internal_no_resume_end" });
    expect(output).toBe(2);
  });

  it("runs internal tail handlers and allows host-local mutation", async () => {
    const output = await compiled.run<number>({ entryName: "internal_tail_mutates_host" });
    expect(output).toBe(7);
  });

  it("runs internal resume handlers that mutate host locals before resuming", async () => {
    const output = await compiled.run<number>({
      entryName: "internal_resume_mutates_host_resume",
    });
    expect(output).toBe(12);
  });

  it("runs internal resume handlers that mutate host locals before ending", async () => {
    const output = await compiled.run<number>({
      entryName: "internal_resume_mutates_host_no_resume",
    });
    expect(output).toBe(17);
  });

  it("runs internal void handlers that resume", async () => {
    const output = await compiled.run<number>({ entryName: "internal_notify_resume" });
    expect(output).toBe(10);
  });

  it("runs internal void handlers that end without resuming", async () => {
    const output = await compiled.run<number>({ entryName: "internal_notify_no_resume" });
    expect(output).toBe(107);
  });

  it("runs internal handlers for multi-arg ops", async () => {
    const output = await compiled.run<number>({ entryName: "internal_multi_arg_resume" });
    expect(output).toBe(55);
  });

  it("runs internal handlers that combine resume and tail", async () => {
    const output = await compiled.run<number>({ entryName: "internal_resume_then_tail" });
    expect(output).toBe(12);
  });

  it("exposes findUniqueOpByLabelSuffix on EffectsInfo", () => {
    const awaitOp = effects.findUniqueOpByLabelSuffix("Async::await");
    expect(awaitOp.effectId).toBe(ASYNC_EFFECT_ID);
    expect(awaitOp.opName).toBe("await");
    expect(awaitOp.label?.endsWith("Async::await")).toBe(true);
  });

  it("does not require handlers for ops that are never performed", async () => {
    const output = await compiled.run<number>({
      entryName: "host_boundary_basic",
      handlers: {
        [`${ASYNC_EFFECT_ID}::await`]: ({ resume }, value: unknown) =>
          resume(asNumber("Async::await", value) + 1),
      },
    });

    expect(output).toBe(1222);
  });

  it("resumes a resume effect via handlersByLabelSuffix with :: suffixes", async () => {
    const output = await compiled.run<number>({
      entryName: "host_boundary_basic",
      handlersByLabelSuffix: {
        "Async::await": ({ resume }, value: unknown) =>
          resume(asNumber("Async::await", value) + 1),
      },
    });

    expect(output).toBe(1222);
  });

  it("supports effectId::opName keys without signatureHash when op is not overloaded", async () => {
    const output = await compiled.run<number>({
      entryName: "host_boundary_basic",
      handlers: {
        [`${ASYNC_EFFECT_ID}::await`]: ({ end }, value: unknown) =>
          end(Math.trunc(asNumber("Async::await", value) / 2)),
      },
    });

    expect(output).toBe(5);
  });

  it("supports multi-arg effect ops through effectId::opName handlers", async () => {
    const output = await compiled.run<number>({
      entryName: "host_boundary_multi_arg_op",
      handlers: {
        [`${ASYNC_EFFECT_ID}::await`]: ({ resume }, value: unknown) =>
          resume(asNumber("Async::await", value) + 3),
        [`${ASYNC_EFFECT_ID}::gather`]: (
          { resume },
          left: unknown,
          right: unknown
        ) =>
          resume(
            asNumber("Async::gather.left", left) * 10 +
              asNumber("Async::gather.right", right)
          ),
      },
    });

    expect(output).toBe(56);
  });

  it("lets handlers update host-local state across multiple effect calls", async () => {
    let runningTotal = 0;
    const output = await compiled.run<number>({
      entryName: "host_boundary_host_state_updates",
      handlers: {
        [`${ASYNC_EFFECT_ID}::await`]: ({ resume }, value: unknown) => {
          runningTotal += asNumber("Async::await", value);
          return resume(runningTotal);
        },
      },
    });

    expect(output).toBe(22);
    expect(runningTotal).toBe(12);
  });

  it("continues after a void op when notify resumes", async () => {
    let notifyCalls = 0;
    const output = await compiled.run<number>({
      entryName: "host_boundary_end_on_void",
      handlers: {
        [`${ASYNC_EFFECT_ID}::notify`]: ({ resume }, value: unknown) => {
          notifyCalls += 1;
          expect(asNumber("Async::notify", value)).toBe(9);
          return resume();
        },
      },
    });

    expect(output).toBe(99);
    expect(notifyCalls).toBe(1);
  });

  it("supports ending from a void op handler", async () => {
    const output = await compiled.run<number>({
      entryName: "host_boundary_end_on_void",
      handlers: {
        [`${ASYNC_EFFECT_ID}::notify`]: ({ end }, value: unknown) =>
          end(asNumber("Async::notify", value) + 1000),
      },
    });

    expect(output).toBe(1009);
  });

  it("exposes signatureHashFor for explicit effectId::opName::signatureHash keys", async () => {
    const signatureHash = effects.signatureHashFor({
      effectId: ASYNC_EFFECT_ID,
      opName: "await",
    });
    const output = await compiled.run<number>({
      entryName: "host_boundary_basic",
      handlers: {
        [`${ASYNC_EFFECT_ID}::await::${signatureHash}`]: ({ resume }, value: unknown) =>
          resume(asNumber("Async::await", value) + 1),
      },
    });

    expect(output).toBe(1222);
  });

  it("throws when a handler does not return a continuation call", async () => {
    await expect(
      compiled.run<number>({
        entryName: "host_boundary_basic",
        handlers: {
          [`${ASYNC_EFFECT_ID}::await`]: unsafeHandler(({ resume }, value: unknown) => {
            resume(asNumber("Async::await", value) + 1);
          }),
        },
      })
    ).rejects.toThrow(/must return a continuation call/i);
  });

  it("throws when a resume effect handler returns tail(...)", async () => {
    await expect(
      compiled.run<number>({
        entryName: "host_boundary_basic",
        handlers: {
          [`${ASYNC_EFFECT_ID}::await`]: ({ tail }, value: unknown) =>
            tail(asNumber("Async::await", value)),
        },
      })
    ).rejects.toThrow(/cannot return tail/i);
  });

  it("throws when a tail effect handler does not return tail(...)", async () => {
    await expect(
      compiled.run<number>({
        entryName: "host_boundary_tail",
        handlers: {
          [`${ASYNC_EFFECT_ID}::await_tail`]: ({ end }, value: unknown) =>
            end(asNumber("Async::await_tail", value)),
        },
      })
    ).rejects.toThrow(/must return tail/i);
  });

  it("runs tail effects when the handler returns tail(...)", async () => {
    const output = await compiled.run<number>({
      entryName: "host_boundary_tail",
      handlers: {
        [`${ASYNC_EFFECT_ID}::await_tail`]: ({ tail }, value: unknown) =>
          tail(asNumber("Async::await_tail", value) + 3),
      },
    });

    expect(output).toBe(20);
  });

  it("runs entries that mix resume and tail ops", async () => {
    const output = await compiled.run<number>({
      entryName: "host_boundary_resume_then_tail",
      handlers: {
        [`${ASYNC_EFFECT_ID}::await`]: ({ resume }, value: unknown) =>
          resume(asNumber("Async::await", value) + 1),
        [`${ASYNC_EFFECT_ID}::await_tail`]: ({ tail }, value: unknown) =>
          tail(asNumber("Async::await_tail", value) * 2),
      },
    });

    expect(output).toBe(12);
  });

  it("runs chained tail ops", async () => {
    const output = await compiled.run<number>({
      entryName: "host_boundary_tail_chain",
      handlers: {
        [`${ASYNC_EFFECT_ID}::await_tail`]: ({ tail }, value: unknown) =>
          tail(asNumber("Async::await_tail", value) + 3),
      },
    });

    expect(output).toBe(10);
  });

  it("runs a multi-effect function (Async, IO, Log) end-to-end", async () => {
    const ioEffectId = effects.findUniqueOpByLabelSuffix("IO::read").effectId;
    const logEffectId = effects.findUniqueOpByLabelSuffix("Log::info").effectId;
    const logs: number[] = [];
    const output = await compiled.run<unknown>({
      entryName: "host_boundary_multi",
      handlers: {
        [`${ASYNC_EFFECT_ID}::await`]: ({ resume }, value: unknown) =>
          resume(asNumber("Async::await", value) + 1),
        [`${ioEffectId}::read`]: ({ tail }) => tail(3),
        [`${logEffectId}::info`]: ({ resume }, msg: unknown) => {
          logs.push(asNumber("Log::info", msg));
          return resume();
        },
      },
    });

    expect(output).toBe(null);
    expect(logs).toEqual([14]);
  });

  it("supports generic effect propagation through callbacks", async () => {
    const logEffectId = effects.findUniqueOpByLabelSuffix("Log::info").effectId;
    const logs: number[] = [];
    const output = await compiled.run<number>({
      entryName: "host_boundary_generic",
      handlers: {
        [`${ASYNC_EFFECT_ID}::await`]: ({ resume }, value: unknown) =>
          resume(asNumber("Async::await", value) + 1),
        [`${logEffectId}::info`]: ({ resume }, msg: unknown) => {
          logs.push(asNumber("Log::info", msg));
          return resume();
        },
      },
    });

    expect(output).toBe(6);
    expect(logs).toEqual([6]);
  });

  it("runs a generic effect with an external handler using inferred type args", async () => {
    const output = await compiled.run<number>({
      entryName: "host_generic_effect_inferred",
      handlers: {
        [`${GENERIC_EFFECT_ID}::pass`]: ({ resume }, value: unknown) =>
          resume(asNumber("Gen::pass", value) + 10),
      },
    });

    expect(output).toBe(19);
  });

  it("runs a generic effect with an external handler using explicit type args", async () => {
    const output = await compiled.run<number>({
      entryName: "host_generic_effect_explicit",
      handlers: {
        [`${GENERIC_EFFECT_ID}::pass`]: ({ resume }, value: unknown) =>
          resume(asNumber("Gen::pass", value) + 20),
      },
    });

    expect(output).toBe(29);
  });

  it("runs a generic tail effect with an external handler using explicit type args", async () => {
    const output = await compiled.run<number>({
      entryName: "host_generic_effect_tail_explicit",
      handlers: {
        [`${GENERIC_EFFECT_ID}::pass_tail`]: ({ tail }, value: unknown) =>
          tail(asNumber("Gen::pass_tail", value) + 2),
      },
    });

    expect(output).toBe(8);
  });

  it("runs a generic effect with an internal handler using inferred type args", async () => {
    const output = await compiled.run<number>({
      entryName: "internal_generic_effect_inferred",
    });
    expect(output).toBe(11);
  });

  it("runs a generic effect with an internal handler using explicit type args", async () => {
    const output = await compiled.run<number>({
      entryName: "internal_generic_effect_explicit",
    });
    expect(output).toBe(12);
  });

  it("supports generic internal handlers that choose not to resume", async () => {
    const output = await compiled.run<number>({
      entryName: "internal_generic_effect_no_resume",
    });
    expect(output).toBe(4);
  });

  it("supports generic internal tail handlers that mutate host locals", async () => {
    const output = await compiled.run<number>({
      entryName: "internal_generic_effect_tail_mutation",
    });
    expect(output).toBe(9);
  });
});
